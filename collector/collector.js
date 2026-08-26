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

const MODE = process.argv[2] || 'all'; // upcoming | live | finished | odds | all

let state = { dailyRequests: 0, lastResetDate: today, trackedIds: [] };
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
    if (state.dailyRequests >= 98) {
        console.log(`No budget for upcoming (used ${state.dailyRequests}/100).`);
        return;
    }

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
    if (state.dailyRequests >= 98) {
        console.log(`No budget for live (used ${state.dailyRequests}/100).`);
        return;
    }

    const data = await liveRequest('/matches?status=live&limit=100');
    const matches = data?.data || [];
    const currentIds = new Set(state.trackedIds || []);

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

    const oddsUrl = `${SUPABASE_URL}/rest/v1/odds?select=match_id&order=captured_at.desc&limit=1000&apikey=${SUPABASE_KEY}`;
    const oddsRes = await fetch(oddsUrl, {
        headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`
        }
    });

    if (!oddsRes.ok) {
        console.error(`Error fetching odds: ${oddsRes.status}`);
        return;
    }

    const odds = await oddsRes.json();
    const oddsMatchIds = new Set(odds.map(o => o.match_id).filter(Boolean));

    if (oddsMatchIds.size === 0) {
        console.log('No odds found. Skipping finished checks.');
        return;
    }

    const previousIds = new Set(state.trackedIds || []);
    const finishedIds = [...previousIds].filter(id => oddsMatchIds.has(id));

    if (finishedIds.length === 0) {
        console.log('No finished matches with odds to check.');
        return;
    }

    const MAX_FINISHED_PER_RUN = 20;
    const toCheck = finishedIds.slice(0, Math.min(finishedIds.length, MAX_FINISHED_PER_RUN, finishedBudget - 2));
    console.log(`Checking ${toCheck.length}/${finishedIds.length} finished matches with odds (budget ${finishedBudget})...`);

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

async function collectOdds() {
    console.log('Mode: odds');
    const ODDS_API_KEY = 'cd537e87d7f2a362b3d6b3a9c57d9f5b';
    const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

    if (state.dailyRequests >= 95) {
        console.log(`No budget for odds (used ${state.dailyRequests}/100).`);
        return;
    }

    const url = `${ODDS_API_BASE}/sports/tennis/odds/?regions=eu&markets=h2h&oddsFormat=decimal&apiKey=${ODDS_API_KEY}`;
    const res = await fetch(url, {
        headers: { 'Accept': 'application/json' }
    });

    if (!res.ok) {
        const errorText = await res.text();
        console.error(`Odds API error ${res.status}: ${errorText}`);
        return;
    }

    const oddsData = await res.json();
    if (!Array.isArray(oddsData) || oddsData.length === 0) {
        console.log('No odds data available');
        return;
    }

    const matchesUrl = `${SUPABASE_URL}/rest/v1/matches?select=id,player1_name,player2_name&apikey=${SUPABASE_KEY}`;
    const matchesRes = await fetch(matchesUrl, {
        headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`
        }
    });

    if (!matchesRes.ok) {
        console.error(`Error fetching matches: ${matchesRes.status}`);
        return;
    }

    const supabaseMatches = await matchesRes.json();
    let matched = 0;

    for (const event of oddsData) {
        const p1Name = event.home_team;
        const p2Name = event.away_team;
        const commenceTime = event.commence_time;

        if (!p1Name || !p2Name) continue;

        const candidates = supabaseMatches.map(m => ({
            id: m.id,
            name: `${m.player1_name || ''} ${m.player2_name || ''}`.trim()
        }));

        const bestMatch = findBestMatch(p1Name, candidates);

        if (bestMatch) {
            const bookmakers = event.bookmakers || [];
            if (bookmakers.length > 0) {
                const markets = bookmakers[0].markets || [];
                if (markets.length > 0) {
                    const outcomes = markets[0].outcomes || [];
                    const p1Odd = outcomes.find(o => o.name === p1Name);
                    const p2Odd = outcomes.find(o => o.name === p2Name);

                    if (p1Odd && p2Odd) {
                        await saveOdds(bestMatch.id, p1Name, p2Name, p1Odd.price, p2Odd.price, commenceTime);
                        matched++;
                    }
                }
            }
        }
    }

    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log(`Odds: matched ${matched}/${oddsData.length}. Requests: ${state.dailyRequests}/100`);
}

function normalizeTeamName(name) {
    return name
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function calculateSimilarity(str1, str2) {
    const s1 = normalizeTeamName(str1);
    const s2 = normalizeTeamName(str2);

    if (s1 === s2) return 1.0;

    const words1 = s1.split(' ');
    const words2 = s2.split(' ');

    let matches = 0;
    for (const w1 of words1) {
        for (const w2 of words2) {
            if (w1 === w2 || (w1.length > 3 && w2.length > 3 && (w1.includes(w2) || w2.includes(w1)))) {
                matches++;
                break;
            }
        }
    }

    const maxLen = Math.max(words1.length, words2.length);
    return maxLen > 0 ? matches / maxLen : 0;
}

function findBestMatch(targetName, candidates, threshold = 0.5) {
    let bestMatch = null;
    let bestScore = threshold;

    for (const candidate of candidates) {
        const score = calculateSimilarity(targetName, candidate.name);
        if (score > bestScore) {
            bestScore = score;
            bestMatch = { id: candidate.id, name: candidate.name, score };
        }
    }

    return bestMatch;
}

async function saveOdds(matchId, player1Name, player2Name, odd1, odd2, commenceTime) {
    const payload = {
        match_id: matchId,
        player1_name: player1Name,
        player2_name: player2Name,
        player1_odd: odd1,
        player2_odd: odd2,
        source: 'the_odds_api',
        market: 'match_winner',
        sport_key: 'tennis',
        commence_time: commenceTime
    };

    const url = `${SUPABASE_URL}/rest/v1/odds`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        console.error(`Failed to save odds for match ${matchId}: ${res.status} ${await res.text()}`);
    }
}

async function main() {
    if (MODE === 'all') {
        await collectUpcoming();
        await collectLive();
        await collectFinished();
        await collectOdds();
    } else {
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
            case 'odds':
                await collectOdds();
                break;
            default:
                console.error(`Unknown mode: ${MODE}. Use upcoming, live, finished, odds, or all.`);
                process.exit(1);
        }
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
