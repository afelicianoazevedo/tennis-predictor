import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import cron from 'node-cron';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LIVE_API_KEY = fs.readFileSync(path.join(__dirname, '..', 'livetennisapi', 'api.key'), 'utf8').trim();
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BASE_URL = 'https://api.livetennisapi.com/api/public/v1';
const STATE_FILE = path.join(__dirname, 'state.json');
const today = new Date().toISOString().split('T')[0];

const MODE = process.argv[2] || 'schedule'; // upcoming | live | results | odds | schedule | all

let state = {
    dailyRequests: 0,
    lastResetDate: today,
    trackedIds: [],
    previousLiveIds: [],
    lastUpcomingRun: null,
    lastLiveRun: null,
    processedMatchIds: {},
    singleTestMatchId: process.argv[3] || null
};
if (fs.existsSync(STATE_FILE)) {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}
if (state.lastResetDate !== today) {
    state.dailyRequests = 0;
    state.lastResetDate = today;
}

function saveState() {
    state.processedMatchIds = state.processedMatchIds || {};
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    for (const [id, ts] of Object.entries(state.processedMatchIds)) {
        if (ts < oneDayAgo) {
            delete state.processedMatchIds[id];
        }
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function liveRequest(endpoint, retries = 3) {
    if (state.dailyRequests >= 100) {
        console.log('Daily limit reached (100 requests). Skipping.');
        return null;
    }
    const url = `${BASE_URL}${endpoint}`;
    const res = await fetch(url, {
        headers: {
            'X-API-Key': LIVE_API_KEY,
            'User-Agent': 'Mozilla/5.0 (compatible; TennisCollector/1.0)'
        }
    });
    
    if (res.status === 429) {
        if (retries > 0) {
            const waitTime = Math.pow(2, 3 - retries) * 1000;
            console.log(`Rate limited. Waiting ${waitTime}ms before retry...`);
            await new Promise(r => setTimeout(r, waitTime));
            return liveRequest(endpoint, retries - 1);
        }
        console.error(`API error 429: ${endpoint} (max retries reached)`);
        state.dailyRequests++;
        return null;
    }
    
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

    const p1 = match.players?.p1 || {};
    const p2 = match.players?.p2 || {};

    const player1Id = await syncPlayer(p1);
    const player2Id = await syncPlayer(p2);

    let winnerId = null;
    if (match.winner) {
        winnerId = await syncPlayer({ id: match.winner, name: '' });
    }

    let status = mapStatus(match.status);
    let score = formatScore(match);

    if (status === 'completed' && isZeroZeroResult(match)) {
        status = 'cancelled';
        score = null;
    }

    const payload = {
        api_id: externalId,
        scheduled_at: scheduledAt,
        status: status,
        score: score,
        sets: match.score?.sets ? JSON.stringify(match.score.sets) : null,
        round: match.round || null,
        surface: match.surface || null,
        player1_name: p1.name || null,
        player2_name: p2.name || null,
        tournament_name: match.tournament?.name || null,
        player1_id: player1Id,
        player2_id: player2Id,
        category: getCategory(match, p1.name, p2.name),
        winner_id: status === 'cancelled' ? null : winnerId
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

    let matchId = null;
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
        matchId = existing[0].id;
    } else {
        const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/matches`, {
            method: 'POST',
            headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!insertRes.ok) {
            return null;
        }

        try {
            const inserted = await insertRes.json();
            matchId = inserted?.id || inserted?.[0]?.id || null;
        } catch (e) {
            return null;
        }
    }

    if (matchId && mapStatus(match.status) === 'completed' && winnerId) {
        await updatePredictionResults(matchId, winnerId);
    }

    return matchId;
}

async function syncPlayer(player) {
    if (!player || !player.id || !player.name) return null;

    const apiId = String(player.id);
    const name = player.name;
    const ranking = player.ranking || null;
    const gender = player.gender || null;

    let res = await fetch(`${SUPABASE_URL}/rest/v1/players?api_id=eq.${apiId}`, {
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
        await fetch(`${SUPABASE_URL}/rest/v1/players?api_id=eq.${apiId}`, {
            method: 'PATCH',
            headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name, ranking, gender })
        });
        return existing[0].id;
    }

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/players`, {
        method: 'POST',
        headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ api_id: apiId, name, ranking, gender })
    });

    if (!insertRes.ok) {
        return null;
    }

    let inserted = null;
    try {
        inserted = await insertRes.json();
    } catch (e) {
        return null;
    }
    return inserted?.id || inserted?.[0]?.id || null;
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

function isZeroZeroResult(match) {
    if (!match.score) return true;
    const games = match.score.games;
    if (!games || games.length === 0) return true;
    return games.every(s => s[0] === 0 && s[1] === 0);
}

function getCategory(match, p1Name, p2Name) {
    if (match.is_doubles || (p1Name && p1Name.includes('/')) || (p2Name && p2Name.includes('/'))) {
        return 'D';
    }
    const tour = (match.tour || '').toLowerCase();
    const tournament = (match.tournament || '').toLowerCase();
    if (tour === 'wta' || tournament.startsWith('w') || tournament.includes('women') || tournament.includes('wta')) {
        return 'W';
    }
    if (tour === 'atp' || tournament.startsWith('m') || tournament.includes('men') || tournament.includes('atp')) {
        return 'M';
    }
    return 'M';
}

async function collectUpcoming() {
    console.log('Mode: upcoming');
    if (state.dailyRequests >= 98) {
        console.log(`No budget for upcoming (used ${state.dailyRequests}/100).`);
        return;
    }

    let data = null;
    let matches = [];
    try {
        data = await liveRequest('/matches?status=upcoming&limit=100');
        matches = data?.data || [];
    } catch (e) {
        console.error('Upcoming collection failed:', e.message);
    }

    const currentIds = new Set();

    for (const match of matches) {
        currentIds.add(match.id);
        try {
            await supabaseUpsert(match);
        } catch (e) {
            console.error(`Failed to upsert match ${match.id}:`, e.message);
        }
    }

    state.trackedIds = [...currentIds];
    state.lastUpcomingRun = new Date().toISOString();
    saveState();
    console.log(`Upcoming: processed ${matches.length}. Requests: ${state.dailyRequests}/100`);
    await triggerPredictions();
}

async function collectLive() {
    console.log('Mode: live');
    if (state.dailyRequests >= 98) {
        console.log(`No budget for live (used ${state.dailyRequests}/100).`);
        return;
    }

    let data = null;
    let matches = [];
    try {
        data = await liveRequest('/matches?status=live&limit=100');
        matches = data?.data || [];
    } catch (e) {
        console.error('Live collection failed:', e.message);
    }

    const currentLiveIds = new Set(matches.map(m => m.id));
    const previousLiveIds = new Set(state.previousLiveIds || []);
    const finishedIds = [...previousLiveIds].filter(id => !currentLiveIds.has(id));

    for (const match of matches) {
        try {
            await supabaseUpsert(match);
        } catch (e) {
            console.error(`Failed to upsert live match ${match.id}:`, e.message);
        }
    }

    state.previousLiveIds = [...currentLiveIds];
    state.lastLiveRun = new Date().toISOString();
    saveState();
    console.log(`Live: processed ${matches.length}. Requests: ${state.dailyRequests}/100`);
    await triggerPredictions();

    if (finishedIds.length > 0) {
        console.log(`Detected ${finishedIds.length} matches that left live status. Queued for result verification.`);
        await collectResults(finishedIds);
    }
}

async function collectResults(candidateIds) {
    console.log('Mode: results');
    const resultsBudget = Math.max(0, 100 - state.dailyRequests);
    if (resultsBudget < 1) {
        console.log(`No budget for results (used ${state.dailyRequests}/100).`);
        return;
    }

    const unprocessed = candidateIds.filter(id => !isProcessed(id));
    if (unprocessed.length === 0) {
        console.log('Results: all candidates already processed.');
        return;
    }

    const supabaseIds = unprocessed.slice(0, 200).join(',');
    const matchesUrl = `${SUPABASE_URL}/rest/v1/matches?api_id=in.(${supabaseIds})&select=id,api_id,category,confidence_score,predicted_winner_id,player1_name,player2_name,scheduled_at&apikey=${SUPABASE_KEY}`;
    const matchesRes = await fetch(matchesUrl, {
        headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`
        }
    });

    if (!matchesRes.ok) {
        console.error(`Error fetching match metadata: ${matchesRes.status}`);
        return;
    }

    const matchMeta = await matchesRes.json();
    const todayStr = new Date().toISOString().split('T')[0];
    const metaMap = new Map(matchMeta.map(m => [m.id, m]));

    const todaysMatches = matchMeta.filter(m => {
        const matchDate = m.scheduled_at ? m.scheduled_at.split('T')[0] : '';
        return matchDate === todayStr && m.category !== 'D';
    });

    const withPrediction = todaysMatches.filter(m => m.predicted_winner_id);
    const sorted = withPrediction.sort((a, b) => (b.confidence_score || 0) - (a.confidence_score || 0));

    const toCheck = sorted.slice(0, Math.min(sorted.length, resultsBudget));
    if (state.singleTestMatchId) {
        const singleIndex = toCheck.findIndex(m => String(m.id) === String(state.singleTestMatchId));
        if (singleIndex >= 0) {
            toCheck.length = 0;
            toCheck.push(sorted[singleIndex]);
        }
    }
    console.log(`Results: verifying ${toCheck.length}/${withPrediction.length} matches (budget ${resultsBudget})...`);

    let verified = 0;
    for (const m of toCheck) {
        if (state.dailyRequests >= 100) break;
        const detail = await liveRequest(`/matches/${m.api_id}`);
        if (detail?.status) {
            const matchStatus = mapStatus(detail.status);
            if (matchStatus === 'completed') {
                if (isZeroZeroResult(detail)) {
                    await supabaseUpsert(detail);
                    markProcessed(m.api_id);
                    continue;
                }
                const internalMatchId = await supabaseUpsert(detail);
                const matchWinnerId = detail.winner ? (await syncPlayer(detail.winner)) : null;
                if (internalMatchId && matchWinnerId) {
                    await updatePredictionResults(internalMatchId, matchWinnerId);
                }
                markProcessed(m.api_id);
                verified++;
            }
        }
        await new Promise(r => setTimeout(r, 500));
    }

    console.log(`Results: verified ${verified} completed matches. Requests: ${state.dailyRequests}/100`);
}

async function updatePredictionResults(matchId, winnerId) {
    if (!matchId || !winnerId) return;

    const predictionsRes = await fetch(`${SUPABASE_URL}/rest/v1/match_predictions?match_id=eq.${matchId}&select=id,predicted_winner_id&apikey=${SUPABASE_SERVICE_ROLE_KEY || SUPABASE_KEY}`, {
        headers: {
            'apikey': SUPABASE_SERVICE_ROLE_KEY || SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY || SUPABASE_KEY}`
        }
    });

    if (!predictionsRes.ok) return;
    const predictions = await predictionsRes.json();
    if (!predictions || predictions.length === 0) return;

    for (const pred of predictions) {
        const wasCorrect = pred.predicted_winner_id === winnerId;
        await fetch(`${SUPABASE_URL}/rest/v1/match_predictions?id=eq.${pred.id}`, {
            method: 'PATCH',
            headers: {
                'apikey': SUPABASE_SERVICE_ROLE_KEY || SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY || SUPABASE_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                was_correct: wasCorrect,
                result: wasCorrect ? 'correct' : 'incorrect'
            })
        });
    }
}

async function collectStaleUpcoming() {
    const now = new Date().toISOString();
    const staleUrl = `${SUPABASE_URL}/rest/v1/matches?status=eq.upcoming&scheduled_at=lte.${now}&select=api_id,scheduled_at,category&limit=20&apikey=${SUPABASE_KEY}`;
    const staleRes = await fetch(staleUrl, {
        headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`
        }
    });

    if (!staleRes.ok) {
        console.error(`Error fetching stale matches: ${staleRes.status}`);
        return;
    }

    const staleMatches = await staleRes.json();
    const staleIds = staleMatches
        .filter(m => !isProcessed(m.api_id) && m.category !== 'D')
        .map(m => m.api_id);

    if (staleIds.length > 0) {
        console.log(`Found ${staleIds.length} stale upcoming matches.`);
        await collectResults(staleIds);
    }
}

async function collectOdds() {
    console.log('Mode: odds');
    const ODDS_API_KEY = 'cd537e87d7f2a362b3d6b3a9c57d9f5b';
    const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

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

    const matchMap = new Map();
    for (const m of supabaseMatches) {
        const p1 = m.player1_name || '';
        const p2 = m.player2_name || '';
        matchMap.set(m.id, { p1, p2 });
    }

    for (const event of oddsData) {
        const p1Name = event.home_team;
        const p2Name = event.away_team;
        const commenceTime = event.commence_time;

        if (!p1Name || !p2Name) continue;

        const bookmakers = event.bookmakers || [];
        if (bookmakers.length === 0) continue;
        const markets = bookmakers[0].markets || [];
        if (markets.length === 0) continue;
        const outcomes = markets[0].outcomes || [];
        const p1Odd = outcomes.find(o => o.name === p1Name);
        const p2Odd = outcomes.find(o => o.name === p2Name);

        if (!p1Odd || !p2Odd) continue;

        let bestMatchId = null;
        let bestScore = 0.5;

        for (const [id, names] of matchMap) {
            const score1 = calculateSimilarity(p1Name, names.p1);
            const score2 = calculateSimilarity(p2Name, names.p2);
            const avgScore = (score1 + score2) / 2;
            if (avgScore > bestScore) {
                bestScore = avgScore;
                bestMatchId = id;
            }
        }

        if (!bestMatchId) {
            for (const [id, names] of matchMap) {
                const p1Surname = names.p1.split(' ').pop();
                const p2Surname = names.p2.split(' ').pop();
                const oddsP1Surname = p1Name.split(' ').pop();
                const oddsP2Surname = p2Name.split(' ').pop();
                const surnameScore = (calculateSimilarity(oddsP1Surname, p1Surname) + calculateSimilarity(oddsP2Surname, p2Surname)) / 2;
                if (surnameScore > bestScore) {
                    bestScore = surnameScore;
                    bestMatchId = id;
                }
            }
        }

        if (!bestMatchId) {
            for (const [id, names] of matchMap) {
                const p1First = names.p1.split(' ')[0];
                const p2First = names.p2.split(' ')[0];
                const oddsP1First = p1Name.split(' ')[0];
                const oddsP2First = p2Name.split(' ')[0];
                const firstScore = (calculateSimilarity(oddsP1First, p1First) + calculateSimilarity(oddsP2First, p2First)) / 2;
                if (firstScore > bestScore) {
                    bestScore = firstScore;
                    bestMatchId = id;
                }
            }
        }

        if (bestMatchId) {
            await saveOdds(bestMatchId, p1Name, p2Name, p1Odd.price, p2Odd.price, commenceTime);
            matched++;
        } else {
            await saveRawOdds(event.id, event.sport_key, p1Name, p2Name, p1Odd.price, p2Odd.price, commenceTime);
        }
    }

    saveState();
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

async function saveRawOdds(eventId, sportKey, homeTeam, awayTeam, homeOdd, awayOdd, commenceTime) {
    const payload = {
        event_id: eventId,
        sport_key: sportKey,
        home_team: homeTeam,
        away_team: awayTeam,
        player1_odd: homeOdd,
        player2_odd: awayOdd,
        source: 'the_odds_api',
        market: 'match_winner',
        commence_time: commenceTime,
        matched: false
    };

    const url = `${SUPABASE_URL}/rest/v1/odds_raw`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'apikey': SUPABASE_SERVICE_ROLE_KEY || SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY || SUPABASE_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        console.error(`Failed to save raw odds for event ${eventId}: ${res.status} ${await res.text()}`);
    }
}

async function triggerPredictions() {
    if (!SUPABASE_SERVICE_ROLE_KEY) {
        console.log('No service role key configured, skipping predictions');
        return;
    }
    if (state.dailyRequests >= 100) return;
    const url = `${SUPABASE_URL}/rest/v1/rpc/generate_all_predictions`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'apikey': SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json'
        }
    });
    if (res.ok) {
        const result = await res.json();
        console.log('Predictions generated:', result);
    } else {
        const text = await res.text();
        console.error('Failed to trigger predictions:', res.status, text);
    }
}

function isProcessed(matchId) {
    if (!state.processedMatchIds) return false;
    const processedAt = state.processedMatchIds[matchId];
    if (!processedAt) return false;
    const processedDate = new Date(processedAt).toISOString().split('T')[0];
    return processedDate === today;
}

function markProcessed(matchId) {
    state.processedMatchIds = state.processedMatchIds || {};
    state.processedMatchIds[matchId] = new Date().toISOString();
    saveState();
}

async function runSchedule() {
    console.log('Starting collector scheduler...');
    if (state.singleTestMatchId) {
        console.log(`[Scheduler] Single test mode enabled for match ${state.singleTestMatchId}`);
    }

    cron.schedule('0 0 * * *', async () => {
        const runDate = new Date().toISOString().split('T')[0];
        if (state.lastUpcomingRun && state.lastUpcomingRun.startsWith(runDate)) return;
        console.log('[Scheduler] Running upcoming collection (00:00)...');
        state.dailyRequests = 0;
        state.lastResetDate = today;
        await collectUpcoming();
    });

    cron.schedule('0 12 * * *', async () => {
        const runDate = new Date().toISOString().split('T')[0];
        if (state.lastUpcomingRun && state.lastUpcomingRun.startsWith(runDate)) return;
        console.log('[Scheduler] Running upcoming collection (12:00)...');
        state.dailyRequests = 0;
        state.lastResetDate = today;
        await collectUpcoming();
    });

    cron.schedule('0 * * * *', async () => {
        console.log('[Scheduler] Running live collection...');
        state.dailyRequests = 0;
        state.lastResetDate = today;
        await collectLive();
    });

    console.log('Scheduler active. Upcoming: 00:00 & 12:00 | Live: every hour');
}

async function main() {
    if (MODE === 'schedule') {
        await runSchedule();
        process.on('SIGINT', () => {
            console.log('Shutting down scheduler...');
            process.exit(0);
        });
        await new Promise(() => {});
    } else if (MODE === 'all') {
        await collectUpcoming();
        await collectLive();
        await collectResults([...new Set(state.trackedIds)].filter(id => !isProcessed(id)));
        await collectStaleUpcoming();
        await collectOdds();
        await triggerPredictions();
    } else {
        switch (MODE) {
            case 'upcoming':
                await collectUpcoming();
                break;
            case 'live':
                await collectLive();
                break;
            case 'results':
                await collectResults([...new Set(state.trackedIds)].filter(id => !isProcessed(id)));
                break;
            case 'odds':
                await collectOdds();
                break;
            default:
                console.error(`Unknown mode: ${MODE}. Use upcoming, live, results, odds, schedule, or all.`);
                process.exit(1);
        }
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
