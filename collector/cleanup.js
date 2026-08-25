import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

async function deleteTbdMatches() {
    const p = new URLSearchParams();
    p.set('or', '(player1_name.is.null,player2_name.is.null)');
    p.set('apikey', SUPABASE_KEY);
    const url = `${SUPABASE_URL}/rest/v1/matches?${p}`;
    const res = await fetch(url, {
        headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`
        }
    });

    if (!res.ok) {
        console.error(`Error fetching matches: ${res.status} ${await res.text()}`);
        return;
    }

    const matches = await res.json();
    console.log(`Found ${matches.length} matches with TBD/null names`);

    if (matches.length === 0) {
        console.log('No matches to delete');
        return;
    }

    const ids = matches.map(m => m.id);
    console.log(`Deleting matches: ${ids.join(', ')}`);

    for (const id of ids) {
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
            console.error(`Failed to delete match ${id}: ${deleteRes.status} ${await deleteRes.text()}`);
        }
    }

    console.log(`Deleted ${ids.length} matches with TBD/null names`);
}

deleteTbdMatches().catch(err => {
    console.error(err);
    process.exit(1);
});
