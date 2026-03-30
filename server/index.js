import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';

// ── Config ──
const PORT = process.env.PORT || 3000;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

const app = express();
app.use(express.json({ limit: '10mb' })); // large payloads for camera images
app.use(cors({
    origin: process.env.ALLOWED_ORIGIN || '*',
    methods: ['GET', 'POST']
}));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── In-memory conversation store (per device, keyed by device ID) ──
// In production this moves to Airtable, but this works for now
const sessions = new Map();

function getSession(deviceId) {
    if (!sessions.has(deviceId)) {
        sessions.set(deviceId, {
            conversationHistory: [],
            workMode: false,
            workModeTranscript: [],
            createdAt: new Date().toISOString()
        });
    }
    return sessions.get(deviceId);
}

// ── Airtable helpers ──
const AIRTABLE_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`;

async function airtableRequest(tableName, method = 'GET', body = null) {
    const url = `${AIRTABLE_URL}/${encodeURIComponent(tableName)}`;
    const opts = {
        method,
        headers: {
            'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
            'Content-Type': 'application/json'
        }
    };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(url, opts);
    return resp.json();
}

async function createTask(task) {
    return airtableRequest('JARVIS Tasks', 'POST', {
        records: [{
            fields: {
                'Task': task.title,
                'Details': task.details || '',
                'Priority': task.priority || 'Medium',
                'Status': 'To Do',
                'Source': task.source || 'Voice',
                'Assigned To': task.assignedTo || 'Paul',
                'Due Date': task.dueDate || null,
                'Category': task.category || 'General',
                'Created By JARVIS': new Date().toISOString()
            }
        }]
    });
}

async function createMemory(memory) {
    return airtableRequest('JARVIS Memory', 'POST', {
        records: [{
            fields: {
                'Summary': memory.summary,
                'Full Context': memory.context || '',
                'Type': memory.type || 'Observation',
                'Tags': memory.tags || '',
                'Timestamp': new Date().toISOString()
            }
        }]
    });
}

async function getRecentTasks(limit = 10) {
    const url = `${AIRTABLE_URL}/${encodeURIComponent('JARVIS Tasks')}?maxRecords=${limit}&sort%5B0%5D%5Bfield%5D=Created+By+JARVIS&sort%5B0%5D%5Bdirection%5D=desc`;
    const resp = await fetch(url, {
        headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` }
    });
    return resp.json();
}

async function getRecentMemories(limit = 20) {
    const url = `${AIRTABLE_URL}/${encodeURIComponent('JARVIS Memory')}?maxRecords=${limit}&sort%5B0%5D%5Bfield%5D=Timestamp&sort%5B0%5D%5Bdirection%5D=desc`;
    const resp = await fetch(url, {
        headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` }
    });
    return resp.json();
}

// ── System prompt with memory context ──
async function buildSystemPrompt(session) {
    let memoryContext = '';
    try {
        const [tasks, memories] = await Promise.all([
            getRecentTasks(10),
            getRecentMemories(15)
        ]);

        if (tasks.records?.length) {
            memoryContext += '\n\nRECENT TASKS:\n';
            tasks.records.forEach(r => {
                const f = r.fields;
                memoryContext += `- [${f.Status}] ${f.Task}${f['Assigned To'] ? ' → ' + f['Assigned To'] : ''}${f['Due Date'] ? ' (due ' + f['Due Date'] + ')' : ''}\n`;
            });
        }

        if (memories.records?.length) {
            memoryContext += '\n\nRECENT MEMORY:\n';
            memories.records.forEach(r => {
                const f = r.fields;
                memoryContext += `- [${f.Type}] ${f.Summary}\n`;
            });
        }
    } catch (e) {
        console.error('Failed to load memory context:', e.message);
    }

    return `You are JARVIS, personal AI assistant for Paul, General Manager of Atelier Domingue — a steel doors and windows fabrication shop in Louisiana. You have vision through a camera.

Personality: confident, precise, direct. Like Tony Stark's JARVIS. Never sycophantic. You remember everything.

Expertise: steel fabrication, welding, door/window manufacturing, production management, QC, material ID, equipment, measurements, shop operations, scheduling.

CRITICAL RULES:
1. Keep ALL spoken responses under 2 short sentences. They are spoken aloud. Be direct and punchy.
2. Reference earlier conversation and memory when relevant — you have a persistent memory.
3. When the user mentions a task, action item, deadline, or reminder — extract it and include it in your response metadata.
4. When you learn something new about staff, projects, clients, or operations — note it as a memory.
${memoryContext}`;
}

// ── ROUTES ──

// Health check
app.get('/', (req, res) => {
    res.json({ status: 'JARVIS online', uptime: process.uptime() });
});

// Main chat endpoint
app.post('/api/chat', async (req, res) => {
    try {
        const { deviceId = 'default', message, image } = req.body;
        const session = getSession(deviceId);

        // Build message content
        const content = [];
        if (image) {
            content.push({
                type: 'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: image }
            });
        }
        content.push({ type: 'text', text: message });
        session.conversationHistory.push({ role: 'user', content });

        // Keep conversation manageable
        if (session.conversationHistory.length > 30) {
            session.conversationHistory = session.conversationHistory.slice(-24);
        }

        const systemPrompt = await buildSystemPrompt(session);

        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-5-20241022',
            max_tokens: 500,
            system: systemPrompt,
            messages: session.conversationHistory
        });

        const reply = response.content[0].text;
        session.conversationHistory.push({ role: 'assistant', content: reply });

        // Extract tasks and memories in the background (don't slow down response)
        extractAndStore(message, reply, session).catch(e =>
            console.error('Background extraction failed:', e.message)
        );

        res.json({ reply, status: 'ok' });
    } catch (err) {
        console.error('Chat error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Work mode: process a chunk of passive transcript
app.post('/api/workmode/process', async (req, res) => {
    try {
        const { deviceId = 'default', transcript } = req.body;
        const session = getSession(deviceId);

        // Ask Claude to extract actionable items from the transcript
        const extraction = await anthropic.messages.create({
            model: 'claude-sonnet-4-5-20241022',
            max_tokens: 1000,
            system: `You are JARVIS, analyzing a transcript of workplace conversation at Atelier Domingue, a steel fabrication shop. Extract any actionable items.

Return JSON only, no other text:
{
  "tasks": [
    { "title": "...", "details": "...", "priority": "High/Medium/Low", "assignedTo": "...", "dueDate": "YYYY-MM-DD or null", "category": "Production/QC/Client/Admin/Personal" }
  ],
  "memories": [
    { "summary": "...", "type": "Decision/Observation/Client Info/Staff Info/Project Update", "tags": "comma,separated" }
  ],
  "relevant": true/false
}

If nothing actionable, return { "tasks": [], "memories": [], "relevant": false }.
Be selective — only capture things that matter. Skip small talk and noise.`,
            messages: [{ role: 'user', content: `Transcript chunk:\n\n${transcript}` }]
        });

        let parsed;
        try {
            const text = extraction.content[0].text;
            // Handle possible markdown code blocks
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
        } catch (e) {
            parsed = { tasks: [], memories: [], relevant: false };
        }

        // Store extracted items in Airtable
        const stored = { tasks: 0, memories: 0 };
        for (const task of parsed.tasks) {
            try {
                await createTask({ ...task, source: 'Work Mode' });
                stored.tasks++;
            } catch (e) {
                console.error('Failed to store task:', e.message);
            }
        }
        for (const memory of parsed.memories) {
            try {
                await createMemory(memory);
                stored.memories++;
            } catch (e) {
                console.error('Failed to store memory:', e.message);
            }
        }

        res.json({ ...parsed, stored });
    } catch (err) {
        console.error('Work mode error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Get recent tasks
app.get('/api/tasks', async (req, res) => {
    try {
        const data = await getRecentTasks(20);
        res.json(data.records?.map(r => ({ id: r.id, ...r.fields })) || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get recent memories
app.get('/api/memory', async (req, res) => {
    try {
        const data = await getRecentMemories(30);
        res.json(data.records?.map(r => ({ id: r.id, ...r.fields })) || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Background extraction ──
// After every chat, silently check if there's a task or memory to store
async function extractAndStore(userMessage, assistantReply, session) {
    const extraction = await anthropic.messages.create({
        model: 'claude-haiku-3-5-20241022',
        max_tokens: 500,
        system: `Extract any tasks or memories from this exchange. Return JSON only:
{ "tasks": [{ "title": "...", "details": "...", "priority": "High/Medium/Low", "assignedTo": "...", "dueDate": "YYYY-MM-DD or null", "category": "..." }], "memories": [{ "summary": "...", "type": "...", "tags": "..." }] }
If nothing to extract, return { "tasks": [], "memories": [] }`,
        messages: [{
            role: 'user',
            content: `User said: "${userMessage}"\nJARVIS replied: "${assistantReply}"`
        }]
    });

    let parsed;
    try {
        const text = extraction.content[0].text;
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    } catch (e) {
        return;
    }

    for (const task of (parsed.tasks || [])) {
        await createTask({ ...task, source: 'Chat' }).catch(() => {});
    }
    for (const memory of (parsed.memories || [])) {
        await createMemory(memory).catch(() => {});
    }
}

// ── Start server ──
app.listen(PORT, () => {
    console.log(`\n  ╔══════════════════════════════════════╗`);
    console.log(`  ║  JARVIS Backend — Atelier Domingue   ║`);
    console.log(`  ║  Port: ${PORT}                          ║`);
    console.log(`  ║  Status: ONLINE                      ║`);
    console.log(`  ╚══════════════════════════════════════╝\n`);
});
