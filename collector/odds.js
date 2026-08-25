import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const ODDS_API_KEY = 'cd537e87d7f2a362b3d6b3a9c57d9f5b';
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

async function fetchOdds() {
    const url = `${ODDS_API_BASE}/sports/tennis/odds/?regions=eu&markets=h2h&oddsFormat=decimal&apiKey=${ODDS_API_KEY}`;
    const res = await fetch(url, {
        headers: { 'Accept': 'application/json' }
    });

    if (!res.ok) {
        const errorText = await res.text();
        console.error(`Odds API error ${res.status}: ${errorText}`);
        return null;
    }

    return await res.json();
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

async function getSupabaseMatches() {
    const url = `${SUPABASE_URL}/rest/v1/matches?select=id,player1_name,player2_name,scheduled_at,status&apikey=${SUPABASE_KEY}`;
    const res = await fetch(url, {
        headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`
        }
    });

    if (!res.ok) {
        console.error(`Supabase error ${res.status}: ${await res.text()}`);
        return [];
    }

    return await res.json();
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

async function syncOdds() {
    console.log('Fetching odds from the-odds-api...');
    const oddsData = await fetchOdds();

    if (!oddsData || !Array.isArray(oddsData) || oddsData.length === 0) {
        console.log('No odds data available');
        return;
    }

    console.log(`Fetched ${oddsData.length} events from odds API`);

    const supabaseMatches = await getSupabaseMatches();
    console.log(`Loaded ${supabaseMatches.length} matches from Supabase`);

    let matched = 0;
    let unmatched = 0;

    for (const event of oddsData) {
        const p1Name = event.home_team;
        const p2Name = event.away_team;
        const commenceTime = event.commence_time;

        if (!p1Name || !p2Name) continue;

        const candidates = supabaseMatches.map(m => ({
            id: m.id,
            name: `${m.player1_name} ${m.player2_name}`.trim()
        }));

        const bestMatch = findBestMatch(p1Name, candidates);

        if (bestMatch) {
            const match = supabaseMatches.find(m => m.id === bestMatch.id);
            if (match) {
                const bookmakers = event.bookmakers || [];
                if (bookmakers.length > 0) {
                    const markets = bookmakers[0].markets || [];
                    if (markets.length > 0) {
                        const outcomes = markets[0].outcomes || [];
                        const p1Odd = outcomes.find(o => o.name === p1Name);
                        const p2Odd = outcomes.find(o => o.name === p2Name);

                        if (p1Odd && p2Odd) {
                            await saveOdds(match.id, p1Name, p2Name, p1Odd.price, p2Odd.price, commenceTime);
                            matched++;
                        }
                    }
                }
            }
        } else {
            unmatched++;
        }
    }

    console.log(`Odds sync complete. Matched: ${matched}, Unmatched: ${unmatched}`);
}

syncOdds().catch(err => {
    console.error(err);
    process.exit(1);
});
