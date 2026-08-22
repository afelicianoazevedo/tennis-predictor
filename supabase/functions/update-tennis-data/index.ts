import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const LIVE_TENNIS_API_KEY = Deno.env.get("LIVE_TENNIS_API_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
});

const API_BASE = "https://api.livetennisapi.com/api/public/v1";
const SPORTSCORE_BASE = "https://sportscore.com/api/widget/matches/";
const MIN_REQUEST_INTERVAL_MS = 2500;
let lastRequestTime = 0;

// ============================================================
// UTILITÁRIOS
// ============================================================

async function rateLimitDelay(): Promise<void> {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < MIN_REQUEST_INTERVAL_MS) {
        await new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed));
    }
    lastRequestTime = Date.now();
}

async function canMakeRequest(): Promise<boolean> {
    const { data, error } = await supabase.rpc("can_make_api_request");
    if (error) return false;
    return data === true;
}

async function registerApiRequest(): Promise<void> {
    await supabase.rpc("register_api_request");
}

async function logApiRequest(params: {
    endpoint: string;
    parameters: Record<string, unknown> | null;
    http_status: number | null;
    success: boolean;
    request_type: string;
    response_time_ms: number | null;
    error_message: string | null;
}): Promise<void> {
    await supabase.from("api_requests").insert({
        endpoint: params.endpoint,
        parameters: params.parameters,
        http_status: params.http_status,
        success: params.success,
        request_type: params.request_type,
        response_time_ms: params.response_time_ms,
        error_message: params.error_message,
    });
}

async function apiFetch<T>(endpoint: string, params?: Record<string, string | number | undefined>): Promise<{ data: T | null; status: number; error: string | null }> {
    if (!await canMakeRequest()) {
        return { data: null, status: 429, error: "API quota exhausted" };
    }

    await rateLimitDelay();

    const url = new URL(`${API_BASE}${endpoint}`);
    if (params) {
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined) url.searchParams.set(key, String(value));
        }
    }

    const startTime = Date.now();
    let response: Response;

    try {
        response = await fetch(url.toString(), {
            headers: { "Authorization": `Bearer ${LIVE_TENNIS_API_KEY}`, "Content-Type": "application/json" },
        });
    } catch (e) {
        await logApiRequest({ endpoint, parameters: params ?? null, http_status: null, success: false, request_type: "unknown", response_time_ms: Date.now() - startTime, error_message: String(e) });
        return { data: null, status: 0, error: String(e) };
    }

    await registerApiRequest();

    if (!response.ok) {
        const errorText = await response.text();
        await logApiRequest({ endpoint, parameters: params ?? null, http_status: response.status, success: false, request_type: endpoint.split("/")[1] || "unknown", response_time_ms: Date.now() - startTime, error_message: errorText });
        return { data: null, status: response.status, error: errorText };
    }

    const json = await response.json();
    await logApiRequest({ endpoint, parameters: params ?? null, http_status: response.status, success: true, request_type: endpoint.split("/")[1] || "unknown", response_time_ms: Date.now() - startTime, error_message: null });
    return { data: json as T, status: response.status, error: null };
}

async function sportscoreFetch(params?: Record<string, string | number>): Promise<{ data: any | null; error: string | null }> {
    const url = new URL(SPORTSCORE_BASE);
    if (params) {
        for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, String(value));
        }
    }

    const startTime = Date.now();
    try {
        const response = await fetch(url.toString(), {
            headers: { "Accept": "application/json" },
        });

        if (!response.ok) {
            const errorText = await response.text();
            await logApiRequest({ endpoint: "sportscore/matches", parameters: params ?? null, http_status: response.status, success: false, request_type: "sportscore", response_time_ms: Date.now() - startTime, error_message: errorText });
            return { data: null, error: errorText };
        }

        const json = await response.json();
        await logApiRequest({ endpoint: "sportscore/matches", parameters: params ?? null, http_status: response.status, success: true, request_type: "sportscore", response_time_ms: Date.now() - startTime, error_message: null });
        return { data: json, error: null };
    } catch (e) {
        await logApiRequest({ endpoint: "sportscore/matches", parameters: params ?? null, http_status: null, success: false, request_type: "sportscore", response_time_ms: Date.now() - startTime, error_message: String(e) });
        return { data: null, error: String(e) };
    }
}

// ============================================================
// GESTÃO DE JOGADORES E TORNEIOS
// ============================================================

async function upsertPlayer(player: any): Promise<{ id: number; created: boolean }> {
    const { data: existing } = await supabase.from("players").select("id").eq("api_id", player.id).maybeSingle();

    const playerData = {
        api_id: player.id,
        name: player.name,
        country: player.country?.toLowerCase() ?? null,
        gender: player.tour === "wta" ? "F" : "M",
        ranking: player.ranking ?? null,
        ranking_points: player.ranking_points ?? null,
        hand: player.hand ?? null,
        birth_date: player.birthday ?? null,
        updated_at: new Date().toISOString(),
    };

    if (existing) {
        await supabase.from("players").update(playerData).eq("api_id", player.id);
        return { id: existing.id, created: false };
    }

    const { data: inserted, error } = await supabase.from("players").insert(playerData).select("id").single();
    if (error) throw new Error(`Failed to insert player: ${error.message}`);
    return { id: inserted.id, created: true };
}

async function upsertTournament(t: any): Promise<{ id: number; created: boolean }> {
    const { data: existing } = await supabase.from("tournaments").select("id").eq("api_id", t.id).maybeSingle();

    const tournamentData = {
        api_id: t.id,
        name: t.name,
        category: t.category,
        surface: t.surface,
        country: t.country?.toLowerCase() ?? null,
        updated_at: new Date().toISOString(),
    };

    if (existing) {
        await supabase.from("tournaments").update(tournamentData).eq("api_id", t.id);
        return { id: existing.id, created: false };
    }

    const { data: inserted, error } = await supabase.from("tournaments").insert(tournamentData).select("id").single();
    if (error) throw new Error(`Failed to insert tournament: ${error.message}`);
    return { id: inserted.id, created: true };
}

async function upsertMatch(match: any, p1Id: number | null, p2Id: number | null, tourId: number | null): Promise<{ id: number; created: boolean }> {
    const { data: existing } = await supabase.from("matches").select("id").eq("api_id", match.id).maybeSingle();

    const matchData = {
        api_id: match.id,
        tournament_id: tourId,
        scheduled_at: match.scheduled_time,
        round: match.round_code ?? match.round,
        status: match.status,
        player1_id: p1Id,
        player2_id: p2Id,
        winner_id: null,
        score: null,
        best_of: match.format === "BO5" ? 5 : match.format === "BO3" ? 3 : null,
        surface: match.surface,
        updated_at: new Date().toISOString(),
    };

    if (existing) {
        await supabase.from("matches").update(matchData).eq("api_id", match.id);
        return { id: existing.id, created: false };
    }

    const { data: inserted, error } = await supabase.from("matches").insert(matchData).select("id").single();
    if (error) throw new Error(`Failed to insert match: ${error.message}`);
    return { id: inserted.id, created: true };
}

async function getExistingTournament(apiId: string): Promise<number | null> {
    const { data } = await supabase.from("tournaments").select("id").eq("api_id", apiId).maybeSingle();
    return data?.id ?? null;
}

// ============================================================
// SINCRONIZAÇÃO DE JOGOS (Live Tennis API)
// ============================================================

async function syncMatches(fromDate: string, toDate: string): Promise<any> {
    const { data, error } = await apiFetch<any>("/matches", { status: "upcoming", from: fromDate, to: toDate, limit: 200 });

    if (error || !data?.data) return { error: error || "No data" };

    const matches = data.data;
    const result = { matches_found: matches.length, players_created: 0, players_updated: 0, tournaments_created: 0, tournaments_updated: 0, matches_created: 0, matches_updated: 0, errors: [] as string[] };

    for (const match of matches) {
        try {
            let p1Id: number | null = null;
            let p2Id: number | null = null;

            if (match.players?.p1) {
                const r = await upsertPlayer(match.players.p1);
                p1Id = r.id;
                r.created ? result.players_created++ : result.players_updated++;
            }
            if (match.players?.p2) {
                const r = await upsertPlayer(match.players.p2);
                p2Id = r.id;
                r.created ? result.players_created++ : result.players_updated++;
            }

            let tourId: number | null = null;
            if (match.tournament_id) {
                const existing = await getExistingTournament(match.tournament_id);
                if (existing) {
                    tourId = existing;
                    result.tournaments_updated++;
                } else {
                    const { data: tData, error: tErr } = await apiFetch<any>(`/tournaments/${match.tournament_id}`);
                    if (tData) {
                        const tr = await upsertTournament(tData);
                        tourId = tr.id;
                        tr.created ? result.tournaments_created++ : result.tournaments_updated++;
                    }
                }
            }

            const mr = await upsertMatch(match, p1Id, p2Id, tourId);
            mr.created ? result.matches_created++ : result.matches_updated++;
        } catch (e: any) {
            result.errors.push(`Match ${match.id}: ${e.message}`);
        }
    }

    return result;
}

// ============================================================
// SINCRONIZAÇÃO DE RESULTADOS (SportScore API)
// ============================================================

async function syncResults(date: string): Promise<any> {
    const { data, error } = await sportscoreFetch({ sport: "tennis", limit: "200" });

    if (error || !data?.matches) {
        return { error: error || "No data from SportScore" };
    }

    const matches = data.matches;
    const targetDate = new Date(date);
    const targetDateStr = targetDate.toISOString().split("T")[0];

    const result = {
        total_from_api: matches.length,
        finished_matches: 0,
        matches_updated: 0,
        matches_not_found: 0,
        errors: [] as string[],
    };

    for (const match of matches) {
        // Só processar jogos terminados
        if (match.status !== "finished") continue;
        result.finished_matches++;

        // Verificar se o jogo é da data pretendida
        const matchDate = new Date(match.time).toISOString().split("T")[0];
        if (matchDate !== targetDateStr) continue;

        const homeName = match.home;
        const awayName = match.away;
        const homeScore = parseInt(match.home_score) || 0;
        const awayScore = parseInt(match.away_score) || 0;

        // Tentar encontrar o jogo na nossa BD
        const matchId = await findMatchByDateAndPlayers(targetDateStr, homeName, awayName);

        if (matchId) {
            try {
                await supabase.rpc("update_match_result", {
                    p_match_id: matchId,
                    p_home_score: homeScore,
                    p_away_score: awayScore,
                    p_status: "finished",
                });
                result.matches_updated++;
            } catch (e: any) {
                result.errors.push(`Update ${matchId}: ${e.message}`);
            }
        } else {
            result.matches_not_found++;
        }
    }

    return result;
}

async function findMatchByDateAndPlayers(dateStr: string, player1Name: string, player2Name: string): Promise<number | null> {
    // Tentativa 1: Nome exato
    const { data: exactMatch } = await supabase
        .from("matches")
        .select("id, player1:players!matches_player1_id_fkey(name), player2:players!matches_player2_id_fkey(name)")
        .eq("scheduled_at::date", dateStr)
        .or(`and(player1.name.eq.${player1Name},player2.name.eq.${player2Name}),and(player1.name.eq.${player2Name},player2.name.eq.${player1Name})`)
        .maybeSingle();

    if (exactMatch) {
        return exactMatch.id;
    }

    // Tentativa 2: Nome parcial (sobrenome)
    const getLastName = (name: string) => {
        const parts = name.split(" ");
        return parts[parts.length - 1];
    };

    const p1LastName = getLastName(player1Name);
    const p2LastName = getLastName(player2Name);

    const { data: partialMatch } = await supabase
        .from("matches")
        .select("id, player1:players!matches_player1_id_fkey(name), player2:players!matches_player2_id_fkey(name)")
        .eq("scheduled_at::date", dateStr)
        .or(`and(player1.name.ilike.%${p1LastName}%,player2.name.ilike.%${p2LastName}%),and(player1.name.ilike.%${p2LastName}%,player2.name.ilike.%${p1LastName}%)`)
        .maybeSingle();

    return partialMatch?.id ?? null;
}

// ============================================================
// GERAR PREVISÕES
// ============================================================

async function generatePredictions(): Promise<number> {
    const { data, error } = await supabase.rpc("generate_all_predictions");
    if (error) return 0;
    return data ?? 0;
}

// ============================================================
// HANDLER PRINCIPAL
// ============================================================

Deno.serve(async (req: Request) => {
    const url = new URL(req.url);
    const mode = url.searchParams.get("mode") ?? "morning";

    try {
        // Modo: Buscar resultados do dia
        if (mode === "results") {
            const dateParam = url.searchParams.get("date") ?? new Date().toISOString().split("T")[0];
            const result = await syncResults(dateParam);
            return new Response(JSON.stringify({ status: "success", mode, date: dateParam, result }, null, 2), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }

        // Modo: Manhã - Buscar próximos jogos e gerar previsões
        if (mode === "morning") {
            const today = new Date().toISOString().split("T")[0];
            const threeDaysLater = new Date(Date.now() + 3 * 86400000).toISOString().split("T")[0];
            const syncResult = await syncMatches(today, threeDaysLater);
            const predictions = await generatePredictions();
            await supabase.rpc("generate_daily_schedule");
            return new Response(JSON.stringify({ status: "success", mode, syncResult, predictions_generated: predictions }, null, 2), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }

        // Modo: Atualizar jogos ao vivo
        if (mode === "live") {
            const today = new Date().toISOString().split("T")[0];
            const result = await syncMatches(today, today);
            return new Response(JSON.stringify({ status: "success", mode, result }, null, 2), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }

        // Modo: Pré-jogo
        if (mode === "pre_game") {
            const today = new Date().toISOString().split("T")[0];
            const result = await syncMatches(today, today);
            return new Response(JSON.stringify({ status: "success", mode, result }, null, 2), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }

        // Modo: Pós-jogo - buscar resultados e atualizar
        if (mode === "post_game") {
            const today = new Date().toISOString().split("T")[0];
            const syncResult = await syncMatches(today, today);
            const resultsResult = await syncResults(today);
            return new Response(JSON.stringify({ status: "success", mode, sync: syncResult, results: resultsResult }, null, 2), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }

        return new Response(JSON.stringify({ status: "error", message: "Unknown mode. Use: morning, pre_game, live, post_game, results" }), {
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
