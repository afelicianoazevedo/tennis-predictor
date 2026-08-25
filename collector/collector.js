import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LIVE_API_KEY = fs.readFileSync(path.join(__dirname, '..', 'livetennisapi', 'api.key'), 'utf8').trim();
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const BASE_URL = 'https://api.livetennisapi.com/api/public/v1';
const STATE_FILE = path.join(__dirname, 'state.json');
const today = new Date().toISOString().split('T')[0];

const MODE = process.argv[2] || 'upcoming'; // upcoming | live | finished

let state = { dailyRequests: 0, lastResetDate: today, trackedIds: [], finishedQueue: [], lastFinishedCheck: {} };
if (fs.existsSync(STATE_FILE)) {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}
if (state.lastResetDate !== today) {
    state.dailyRequests = 0;
    state.lastResetDate = today;
}

async function liveRequest(endpoint) {
    if (state.dailyRequests >= 100) {
        console.log('Daily limit reached (100 requests). Skipping.');
        return null;
    }
    const url = `${BASE_URL}${endpoint}`;
    const res = await fetch(url, {
        headers: { 'X-API-Key': LIVE_API_KEY }
    });
    state.dailyRequests++;
    if (!res.ok) {
        console.error(`API error ${res.status}: ${endpoint}`);
        return null;
    }
    return res.json();
}

function parseApiDate(dateStr) {
    if (!dateStr) return null;
    const parts = dateStr.split(' ')[0].split('/');
    if (parts.length !== 3) return new Date(dateStr).toISOString().replace('T', ' ').replace('Z', '');
    const [month, day, year] = parts.map(Number);
    const date = new Date(year, month - 1, day);
    return date.toISOString().replace('T', ' ').replace('Z', '');
}

async function supabaseUpsert(match) {
    const externalId = String(match.id);
    const scheduledAt = parseApiDate(match.scheduled_time || match.start_time);

    const payload = {
        api_id: externalId,
        scheduled_at: scheduledAt,
        status: mapStatus(match.status),
        score: formatScore(match),
        sets: match.score?.sets ? JSON.stringify(match.score.sets) : null,
        round: match.round || null,
        surface: match.surface || null,
        player1_name: match.players?.p1?.name || null,
        player2_name: match.players?.p2?.name || null,
        tournament_name: match.tournament?.name || null
    };

    let res = await fetch(`${SUPABASE_URL}/rest/v1/matches?api_id=eq.${externalId}`, {
        method: 'GET',
        headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`
        }
    });

    let existing = [];
    if (res.ok) {
        existing = await res.json();
    }

    if (existing.length > 0) {
        await fetch(`${SUPABASE_URL}/rest/v1/matches?api_id=eq.${externalId}`, {
            method: 'PATCH',
            headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });
        return;
    }

    await fetch(`${SUPABASE_URL}/rest/v1/matches`, {
        method: 'POST',
        headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });
}

function mapStatus(status) {
    const s = (status || '').toLowerCase();
    if (s === 'live' || s === 'inprogress' || s === 'in_progress') return 'live';
    if (s === 'completed' || s === 'finished' || s === 'ft') return 'completed';
    return 'upcoming';
}

function formatScore(match) {
    if (!match.score) return null;
    const score = match.score;
    if (score.games && Array.isArray(score.games)) {
        return score.games.map(s => `${s[0]}-${s[1]}`).join(', ');
    }
    return null;
}

async function collectUpcoming() {
    console.log('Mode: upcoming');
    const data = await liveRequest('/matches?status=upcoming&limit=100');
    const matches = data?.data || [];
    const currentIds = new Set();

    for (const match of matches) {
        currentIds.add(match.id);
        await supabaseUpsert(match);
    }

    state.trackedIds = [...currentIds];
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log(`Upcoming: processed ${matches.length}. Requests: ${state.dailyRequests}/100`);
}

async function collectLive() {
    console.log('Mode: live');
    const data = await liveRequest('/matches?status=live&limit=100');
    const matches = data?.data || [];
    const currentIds = new Set();

    for (const match of matches) {
        currentIds.add(match.id);
        await supabaseUpsert(match);
    }

    state.trackedIds = [...currentIds];
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log(`Live: processed ${matches.length}. Requests: ${state.dailyRequests}/100`);
}

async function collectFinished() {
    console.log('Mode: finished');
    const finishedBudget = Math.max(0, 100 - state.dailyRequests);
    if (finishedBudget < 3) {
        console.log(`No budget for finished checks (used ${state.dailyRequests}/100).`);
        return;
    }

    const previousIds = new Set(state.trackedIds || []);
    const finishedIds = [...previousIds].filter(id => !isCurrentlyActive(id));

    if (finishedIds.length === 0) {
        console.log('No finished matches to check.');
        return;
    }

    const MAX_FINISHED_PER_RUN = 20;
    const toCheck = finishedIds.slice(0, Math.min(finishedIds.length, MAX_FINISHED_PER_RUN, finishedBudget - 2));
    console.log(`Checking ${toCheck.length}/${finishedIds.length} finished matches (budget ${finishedBudget})...`);

    for (const id of toCheck) {
        if (state.dailyRequests >= 100) break;
        const detail = await liveRequest(`/matches/${id}`);
        if (detail?.data) {
            await supabaseUpsert(detail.data);
        }
    }

    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log(`Finished: processed ${toCheck.length}. Requests: ${state.dailyRequests}/100`);
}

async function isCurrentlyActive(id) {
    const upcoming = await liveRequest('/matches?status=upcoming&limit=100');
    const live = await liveRequest('/matches?status=live&limit=100');
    const ids = new Set([
        ...(upcoming?.data || []).map(m => m.id),
        ...(live?.data || []).map(m => m.id)
    ]);
    return ids.has(id);
}

async function main() {
    switch (MODE) {
        case 'upcoming':
            await collectUpcoming();
            break;
        case 'live':
            await collectLive();
            break;
        case 'finished':
            await collectFinished();
            break;
        default:
            console.error(`Unknown mode: ${MODE}. Use upcoming, live, or finished.`);
            process.exit(1);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
