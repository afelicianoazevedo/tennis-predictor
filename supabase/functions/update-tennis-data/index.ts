import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
});

const SPORTSCORE_BASE = "https://sportscore.com/api/widget/matches/";

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

    // Tentar encontrar jogador existente
    const { data: existing } = await supabase.from("players").select("id").ilike("name", name).maybeSingle();
    if (existing) return existing.id;

    // Determinar género baseado no nome (heurística simples)
    const gender = "M"; // Default

    // Criar novo jogador
    const { data: inserted, error } = await supabase.from("players").insert({
        name: name,
        country: country?.toLowerCase() ?? null,
        gender: gender,
        created_at: new Date().toISOString(),
    }).select("id").single();

    if (error) {
        console.error(`Error inserting player ${name}:`, error.message);
        return null;
    }
    return inserted.id;
}

// ============================================================
// SINCRONIZAÇÃO DE TORNEIOS (por nome)
// ============================================================

async function syncTournament(name: string): Promise<number | null> {
    if (!name) return null;

    // Tentar encontrar torneio existente
    const { data: existing } = await supabase.from("tournaments").select("id").ilike("name", name).maybeSingle();
    if (existing) return existing.id;

    // Criar novo torneio
    const { data: inserted, error } = await supabase.from("tournaments").insert({
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
    };

    for (const match of matches) {
        try {
            // Sincronizar jogadores
            const p1Id = await syncPlayer(match.home);
            const p2Id = await syncPlayer(match.away);

            // Sincronizar torneio
            const tourId = await syncTournament(match.competition);

            // Verificar se jogo já existe (por data + jogadores)
            const matchDate = new Date(match.time);
            const startDate = new Date(matchDate);
            startDate.setHours(0, 0, 0, 0);
            const endDate = new Date(matchDate);
            endDate.setHours(23, 59, 59, 999);

            const { data: existing } = await supabase
                .from("matches")
                .select("id")
                .eq("player1_id", p1Id)
                .eq("player2_id", p2Id)
                .gte("scheduled_at", startDate.toISOString())
                .lte("scheduled_at", endDate.toISOString())
                .maybeSingle();

            // Determinar status
            let status = "upcoming";
            if (match.status === "finished") status = "completed";
            else if (match.status === "live") status = "live";

            // Determinar score
            const homeScore = parseInt(match.home_score) || 0;
            const awayScore = parseInt(match.away_score) || 0;
            const score = (match.home_score != null && match.away_score != null) ? `${homeScore}-${awayScore}` : null;

            // Determinar vencedor (apenas para jogos terminados com score)
            let winnerId = null;
            if (status === "completed" && score && score !== "0-0") {
                if (homeScore > awayScore) winnerId = p1Id;
                else if (awayScore > homeScore) winnerId = p2Id;
            }

            if (existing) {
                // Atualizar jogo existente
                await supabase.from("matches").update({
                    status: status,
                    score: score,
                    winner_id: winnerId,
                    tournament_id: tourId,
                    updated_at: new Date().toISOString(),
                }).eq("id", existing.id);
                result.matches_updated++;
            } else {
                // Criar novo jogo
                await supabase.from("matches").insert({
                    player1_id: p1Id,
                    player2_id: p2Id,
                    tournament_id: tourId,
                    scheduled_at: match.time,
                    status: status,
                    score: score,
                    winner_id: winnerId,
                    created_at: new Date().toISOString(),
                });
                result.matches_created++;
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
