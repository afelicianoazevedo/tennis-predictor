import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ODDS_API_KEY = Deno.env.get("ODDS_API_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
});

const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

// ============================================================
// UTILITÁRIOS
// ============================================================

function normalizeTeamName(name: string): string {
    return name
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function calculateSimilarity(str1: string, str2: string): number {
    const s1 = normalizeTeamName(str1);
    const s2 = normalizeTeamName(str2);
    
    if (s1 === s2) return 1.0;
    
    const words1 = s1.split(" ");
    const words2 = s2.split(" ");
    
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

function findBestMatch(
    targetName: string,
    candidates: Array<{ id: number; name: string }>,
    threshold: number = 0.5
): { id: number; name: string; score: number } | null {
    let bestMatch: { id: number; name: string; score: number } | null = null;
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

// ============================================================
// FETCH ODDS
// ============================================================

async function fetchOddsFromAPI(sport: string = "tennis"): Promise<any[]> {
    const url = `${ODDS_API_BASE}/sports/${sport}/odds/?regions=eu&markets=h2h&oddsFormat=decimal&apiKey=${ODDS_API_KEY}`;

    const response = await fetch(url, {
        headers: { "Accept": "application/json" },
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Odds API error ${response.status}: ${errorText}`);
    }

    return await response.json();
}

async function syncOdds(sport: string = "tennis"): Promise<{ success: boolean; message: string; matchesProcessed: number }> {
    try {
        if (!ODDS_API_KEY) {
            return { success: false, message: "ODDS_API_KEY not configured", matchesProcessed: 0 };
        }

        const { data: rateCheck, error: rateError } = await supabase.rpc("can_make_api_request", {
            p_api_name: "the_odds_api",
            p_daily_limit: 15,
            p_monthly_limit: 450
        });

        if (rateError || !rateCheck) {
            return { success: false, message: "Rate limit exceeded for Odds API", matchesProcessed: 0 };
        }

        const oddsData = await fetchOddsFromAPI(sport);
        if (!Array.isArray(oddsData) || oddsData.length === 0) {
            return { success: true, message: "No odds data available", matchesProcessed: 0 };
        }

        await supabase.rpc("record_api_request", {
            p_api_name: "the_odds_api",
            p_count: 1
        });

        const { data: matches } = await supabase
            .from("matches")
            .select("id, player1_id, player2_id, scheduled_at, status")
            .eq("status", "upcoming")
            .not("player1_id", "is", null)
            .not("player2_id", "is", null);

        const { data: players } = await supabase
            .from("players")
            .select("id, name");

        const playerMap = new Map(players?.map(p => [p.id, p.name]) || []);
        let matchesProcessed = 0;
        let oddsSaved = 0;

        for (const match of oddsData) {
            const homeTeam = match.home_team || match.players?.[0];
            const awayTeam = match.away_team || match.players?.[1];

            if (!homeTeam || !awayTeam) continue;

            const bestBookmaker = match.bookmakers?.[0];
            if (!bestBookmaker?.markets?.[0]?.outcomes) continue;

            const outcomes = bestBookmaker.markets[0].outcomes;
            const p1Odd = outcomes.find((o: any) => 
                normalizeTeamName(o.name) === normalizeTeamName(homeTeam)
            )?.price;
            const p2Odd = outcomes.find((o: any) => 
                normalizeTeamName(o.name) === normalizeTeamName(awayTeam)
            )?.price;

            if (!p1Odd || !p2Odd || p1Odd <= 1 || p2Odd <= 1) continue;

            let dbMatchId: number | null = null;
            if (matches && matches.length > 0) {
                const bestHome = findBestMatch(homeTeam, matches.map(m => ({
                    id: m.id,
                    name: playerMap.get(m.player1_id) || ""
                })));

                const bestAway = findBestMatch(awayTeam, matches.map(m => ({
                    id: m.id,
                    name: playerMap.get(m.player2_id) || ""
                })));

                if (bestHome && bestAway && bestHome.id === bestAway.id) {
                    dbMatchId = bestHome.id;
                }
            }

            const { error } = await supabase
                .from("odds")
                .upsert({
                    match_id: dbMatchId,
                    player1_name: homeTeam,
                    player2_name: awayTeam,
                    player1_odd: p1Odd,
                    player2_odd: p2Odd,
                    sport_key: match.sport_key,
                    commence_time: new Date(match.commence_time).toISOString(),
                    market: "match_winner",
                    source: "the_odds_api",
                    captured_at: new Date().toISOString(),
                }, {
                    onConflict: "player1_name,player2_name,market,source,captured_at",
                });

            if (error) {
                console.error(`Error syncing odds for ${homeTeam} vs ${awayTeam}:`, error);
                continue;
            }

            oddsSaved++;

            if (dbMatchId) {
                await supabase.rpc("generate_prediction", { p_match_id: dbMatchId });
                matchesProcessed++;
            }
        }

        return {
            success: true,
            message: `Synced odds for ${oddsSaved} matches (${matchesProcessed} matched to DB)`,
            matchesProcessed,
        };
    } catch (error) {
        console.error("Error syncing odds:", error);
        return {
            success: false,
            message: error instanceof Error ? error.message : "Unknown error",
            matchesProcessed: 0,
        };
    }
}

// ============================================================
// CRON JOB
// ============================================================

async function scheduledOddsSync(): Promise<void> {
    console.log("Starting scheduled odds sync...");
    const result = await syncOdds("tennis");
    console.log(`Odds sync completed: ${result.message}`);
}

// ============================================================
// HANDLER
// ============================================================

Deno.serve(async (req: Request) => {
    const url = new URL(req.url);
    const path = url.pathname.split("/").pop();

    try {
        if (req.method === "POST" && path === "sync") {
            const result = await syncOdds();
            return new Response(
                JSON.stringify(result),
                { headers: { "Content-Type": "application/json" } }
            );
        }

        if (req.method === "GET" && path === "cron") {
            await scheduledOddsSync();
            return new Response(
                JSON.stringify({ message: "Cron sync completed" }),
                { headers: { "Content-Type": "application/json" } }
            );
        }

        return new Response(
            JSON.stringify({ error: "Not found. Use POST /sync or GET /cron" }),
            { status: 404, headers: { "Content-Type": "application/json" } }
        );
    } catch (error) {
        console.error("Error:", error);
        return new Response(
            JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
            { status: 500, headers: { "Content-Type": "application/json" } }
        );
    }
});
