import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

async function filterMatches() {
    const matchesUrl = `${SUPABASE_URL}/rest/v1/matches?select=id,confidence_score,player1_name,player2_name,status&apikey=${SUPABASE_KEY}`;
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

    const matches = await matchesRes.json();
    console.log(`Total matches: ${matches.length}`);

    const oddsUrl = `${SUPABASE_URL}/rest/v1/odds?select=match_id&apikey=${SUPABASE_KEY}`;
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
    console.log(`Matches with odds: ${oddsMatchIds.size}`);

    const toDelete = [];
    const toKeep = [];

    for (const match of matches) {
        const hasOdds = oddsMatchIds.has(match.id);
        const hasConfidence = match.confidence_score != null;
        const isFiftyFifty = match.confidence_score === 50;

        if (!hasConfidence || !hasOdds || isFiftyFifty) {
            toDelete.push(match.id);
        } else {
            toKeep.push(match);
        }
    }

    console.log(`Matches to keep: ${toKeep.length}`);
    console.log(`Matches to delete: ${toDelete.length}`);

    for (const id of toDelete) {
        const deleteUrl = `${SUPABASE_URL}/rest/v1/matches?id=eq.${id}&apikey=${SUPABASE_KEY}`;
        const deleteRes = await fetch(deleteUrl, {
            method: 'DELETE',
            headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`
            }
        });

        if (deleteRes.ok) {
            console.log(`Deleted match ${id}`);
        } else {
            console.error(`Failed to delete match ${id}: ${deleteRes.status}`);
        }
    }

    console.log(`Filtering complete. Kept ${toKeep.length}, deleted ${toDelete.length} matches.`);
}

filterMatches().catch(err => {
    console.error(err);
    process.exit(1);
});
