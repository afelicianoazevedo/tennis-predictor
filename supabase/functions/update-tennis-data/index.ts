import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
});

const SPORTSCORE_BASE = "https://sportscore.com/api/widget/matches/";

function hashToId(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return Math.abs(hash);
}

// ============================================================
// UTILITÁRIOS
// ============================================================

async function sportscoreFetch(params?: Record<string, string | number>): Promise<{ data: any | null; error: string | null }> {
    const url = new URL(SPORTSCORE_BASE);
    if (params) {
        for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, String(value));
        }
    }

    try {
        const response = await fetch(url.toString(), {
            headers: { "Accept": "application/json" },
        });

        if (!response.ok) {
            const errorText = await response.text();
            return { data: null, error: errorText };
        }

        const json = await response.json();
        return { data: json, error: null };
    } catch (e) {
        return { data: null, error: String(e) };
    }
}

// ============================================================
// SINCRONIZAÇÃO DE JOGADORES (por nome)
// ============================================================

async function syncPlayer(name: string, country?: string | null): Promise<number | null> {
    if (!name || name === "Wsf1" || name === "Wsf2" || name === "Wqf1" || name === "Wqf2") return null;

    const apiId = hashToId(name);

    const { data: existing } = await supabase.from("players").select("id").ilike("name", name).maybeSingle();
    if (existing) return existing.id;

    const gender = "M"; // Default

    const { data: inserted, error } = await supabase.from("players").insert({
        api_id: apiId,
        name: name,
        country: country?.toLowerCase() ?? null,
        gender: gender,
        created_at: new Date().toISOString(),
    }).select("id").single();

    if (error) {
        console.error(`Error inserting player ${name}:`, error.message, error.details, error.hint);
        return null;
    }
    return inserted.id;
}

// ============================================================
// SINCRONIZAÇÃO DE TORNEIOS (por nome)
// ============================================================

async function syncTournament(name: string): Promise<number | null> {
    if (!name) return null;

    const apiId = hashToId(name);

    const { data: existing } = await supabase.from("tournaments").select("id").ilike("name", name).maybeSingle();
    if (existing) return existing.id;

    const { data: inserted, error } = await supabase.from("tournaments").insert({
        api_id: apiId,
        name: name,
        created_at: new Date().toISOString(),
    }).select("id").single();

    if (error) {
        console.error(`Error inserting tournament ${name}:`, error.message);
        return null;
    }
    return inserted.id;
}

// ============================================================
// SINCRONIZAÇÃO DE JOGOS
// ============================================================

async function syncMatches(): Promise<any> {
    const { data, error } = await sportscoreFetch({ sport: "tennis", limit: "500" });

    if (error || !data?.matches) {
        return { error: error || "No data from SportScore" };
    }

    const matches = data.matches;
    const result = {
        total_from_api: matches.length,
        players_created: 0,
        tournaments_created: 0,
        matches_created: 0,
        matches_updated: 0,
        errors: [] as string[],
        debug: [] as string[],
    };

    for (const match of matches) {
        try {
            if (!match.home || !match.away || match.home.startsWith("Wsf") || match.home.startsWith("Wqf") || match.away.startsWith("Wsf") || match.away.startsWith("Wqf")) {
                result.debug.push(`Skipped placeholder: ${match.home} vs ${match.away}`);
                continue;
            }

            const p1Id = await syncPlayer(match.home);
            const p2Id = await syncPlayer(match.away);

            if (p1Id === null || p2Id === null) {
                result.debug.push(`Skipped (null player): ${match.home} vs ${match.away}`);
                continue;
            }

            const tourId = await syncTournament(match.competition);

            let status = "upcoming";
            if (match.status === "finished") status = "completed";
            else if (match.status === "live") status = "live";

            const homeScore = match.home_score != null ? parseInt(match.home_score) : null;
            const awayScore = match.away_score != null ? parseInt(match.away_score) : null;
            const score = (homeScore != null && awayScore != null) ? `${homeScore}-${awayScore}` : null;

            let winnerId = null;
            if (status === "completed" && score && score !== "0-0" && homeScore != null && awayScore != null) {
                if (homeScore > awayScore) winnerId = p1Id;
                else if (awayScore > homeScore) winnerId = p2Id;
            }

            if (status === "completed" && score === "0-0") {
                result.debug.push(`Skipped 0-0 completed: ${match.home} vs ${match.away}`);
                continue;
            }

            const matchUrl = match.url || `${match.home}-vs-${match.away}`;
            const apiId = hashToId(matchUrl);
            const matchData = {
                api_id: apiId,
                player1_id: p1Id,
                player2_id: p2Id,
                tournament_id: tourId,
                scheduled_at: match.time,
                status: status,
                score: score,
                winner_id: winnerId,
                sportscore_url: matchUrl,
                home_logo: match.home_logo || null,
                away_logo: match.away_logo || null,
                competition_logo: match.competition_logo || null,
                status_text: match.status_text || null,
                updated_at: new Date().toISOString(),
            };

            let existing = null;

            const { data: byUrl } = await supabase
                .from("matches")
                .select("id")
                .eq("sportscore_url", matchUrl)
                .maybeSingle();

            if (byUrl) {
                existing = byUrl;
            } else {
                const matchDate = match.time ? match.time.split('T')[0] : null;
                if (matchDate) {
                    const { data: byPlayers } = await supabase
                        .from("matches")
                        .select("id")
                        .eq("player1_id", p1Id)
                        .eq("player2_id", p2Id)
                        .eq("scheduled_at", matchDate)
                        .maybeSingle();

                    if (byPlayers) {
                        existing = byPlayers;
                    } else {
                        const { data: byPlayersSwapped } = await supabase
                            .from("matches")
                            .select("id")
                            .eq("player1_id", p2Id)
                            .eq("player2_id", p1Id)
                            .eq("scheduled_at", matchDate)
                            .maybeSingle();

                        if (byPlayersSwapped) {
                            existing = byPlayersSwapped;
                        }
                    }
                }
            }

            if (existing) {
                const { error: updateError } = await supabase
                    .from("matches")
                    .update(matchData)
                    .eq("id", existing.id);

                if (updateError) {
                    result.errors.push(`Update ${match.home} vs ${match.away}: ${updateError.message}`);
                } else {
                    result.matches_updated++;
                }
            } else {
                const insertData = { ...matchData, created_at: new Date().toISOString() };
                const { error: insertError } = await supabase.from("matches").insert(insertData);

                if (insertError) {
                    result.errors.push(`Insert ${match.home} vs ${match.away}: ${insertError.message}`);
                } else {
                    result.matches_created++;
                }
            }

            if (score && score !== "0-0") {
                result.debug.push(`${existing ? 'Updated' : 'Created'}: ${match.home} vs ${match.away}, Status: ${status}, Score: ${score}`);
            }
        } catch (e: any) {
            result.errors.push(`Match ${match.home} vs ${match.away}: ${e.message}`);
        }
    }

    return result;
}

// ============================================================
// HANDLER PRINCIPAL
// ============================================================

Deno.serve(async (req: Request) => {
    const url = new URL(req.url);
    const mode = url.searchParams.get("mode") ?? "sync";

    try {
        if (mode === "sync") {
            const result = await syncMatches();
            return new Response(JSON.stringify({ status: "success", mode, result }, null, 2), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }

        if (mode === "results") {
            // Mantém compatibilidade - sincroniza tudo
            const result = await syncMatches();
            return new Response(JSON.stringify({ status: "success", mode, result }, null, 2), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }

        return new Response(JSON.stringify({ status: "error", message: "Unknown mode. Use: sync, results" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    } catch (e: any) {
        return new Response(JSON.stringify({ status: "error", message: e.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
        });
    }
});
