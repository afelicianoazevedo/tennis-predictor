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
                if (!matchData.score || matchData.score === '0-0') {
                    result.debug.push(`Skipped update 0-0/no-score: ${match.home} vs ${match.away}`);
                } else {
                    const { error: updateError } = await supabase
                        .from("matches")
                        .update(matchData)
                        .eq("id", existing.id);

                    if (updateError) {
                        result.errors.push(`Update ${match.home} vs ${match.away}: ${updateError.message}`);
                    } else {
                        result.matches_updated++;
                    }
                }
            } else {
                if (!matchData.score || matchData.score === '0-0') {
                    result.debug.push(`Skipped insert 0-0/no-score: ${match.home} vs ${match.away}`);
                } else {
                    const insertData = { ...matchData, created_at: new Date().toISOString() };
                    const { error: insertError } = await supabase.from("matches").insert(insertData);

                    if (insertError) {
                        result.errors.push(`Insert ${match.home} vs ${match.away}: ${insertError.message}`);
                    } else {
                        result.matches_created++;
                    }
                }
            }

            if (score && score !== "0-0") {
                result.debug.push(`${existing ? 'Updated' : 'Created'}: ${match.home} vs ${match.away}, Status: ${status}, Score: ${score}`);
            }

            if (status === "completed" && score && score !== "0-0" && existing?.id) {
                await syncMatchStats(existing.id, p1Id, p2Id, match);
                await syncH2H(p1Id, p2Id, match);
                await syncPredictionFactors(existing.id, p1Id, p2Id, match);
            }
        } catch (e: any) {
            result.errors.push(`Match ${match.home} vs ${match.away}: ${e.message}`);
        }
    }

    await syncAllPlayerPerformance();

    return result;
}

async function syncMatchStats(matchId: number, p1Id: number, p2Id: number, match: any): Promise<void> {
    const homeScore = match.home_score != null ? parseInt(match.home_score) : 0;
    const awayScore = match.away_score != null ? parseInt(match.away_score) : 0;

    const p1Stats = {
        match_id: matchId,
        player_id: p1Id,
        service_points_won: homeScore,
        service_points_total: homeScore + awayScore,
        total_points_won: homeScore,
        total_points_played: homeScore + awayScore,
        source: 'sportscore',
    };
    const p2Stats = {
        match_id: matchId,
        player_id: p2Id,
        service_points_won: awayScore,
        service_points_total: homeScore + awayScore,
        total_points_won: awayScore,
        total_points_played: homeScore + awayScore,
        source: 'sportscore',
    };

    await supabase.from("match_player_stats").upsert(p1Stats, { onConflict: "match_id,player_id" });
    await supabase.from("match_player_stats").upsert(p2Stats, { onConflict: "match_id,player_id" });
}

async function syncH2H(p1Id: number, p2Id: number, match: any): Promise<void> {
    const homeScore = match.home_score != null ? parseInt(match.home_score) : 0;
    const awayScore = match.away_score != null ? parseInt(match.away_score) : 0;

    const p1Wins = homeScore > awayScore ? 1 : 0;
    const p2Wins = awayScore > homeScore ? 1 : 0;

    const { data: existing } = await supabase
        .from("player_h2h")
        .select("id, matches_played, player1_wins, player2_wins, player1_sets_won, player2_sets_won")
        .eq("player1_id", p1Id)
        .eq("player2_id", p2Id)
        .maybeSingle();

    if (existing) {
        await supabase.from("player_h2h").update({
            matches_played: (existing.matches_played || 0) + 1,
            player1_wins: (existing.player1_wins || 0) + p1Wins,
            player2_wins: (existing.player2_wins || 0) + p2Wins,
            player1_sets_won: (existing.player1_sets_won || 0) + homeScore,
            player2_sets_won: (existing.player2_sets_won || 0) + awayScore,
            last_match_at: match.time || new Date().toISOString(),
            updated_at: new Date().toISOString(),
        }).eq("id", existing.id);
    } else {
        await supabase.from("player_h2h").insert({
            player1_id: p1Id,
            player2_id: p2Id,
            matches_played: 1,
            player1_wins: p1Wins,
            player2_wins: p2Wins,
            player1_sets_won: homeScore,
            player2_sets_won: awayScore,
            last_match_at: match.time || new Date().toISOString(),
        });
    }
}

async function syncPredictionFactors(matchId: number, p1Id: number, p2Id: number, match: any): Promise<void> {
    const { data: prediction } = await supabase
        .from("match_predictions")
        .select("id, player1_probability, player2_probability, confidence_score")
        .eq("match_id", matchId)
        .maybeSingle();

    if (!prediction) return;

    await supabase.from("match_prediction_factors").upsert({
        match_id: matchId,
        prediction_id: prediction.id,
        player1_strength_score: prediction.player1_probability,
        player2_strength_score: prediction.player2_probability,
        player1_form_score: prediction.player1_probability,
        player2_form_score: prediction.player2_probability,
        player1_surface_score: prediction.player1_probability,
        player2_surface_score: prediction.player2_probability,
        player1_serve_score: prediction.player1_probability,
        player2_serve_score: prediction.player2_probability,
        player1_return_score: prediction.player1_probability,
        player2_return_score: prediction.player2_probability,
        player1_sos_score: prediction.player1_probability,
        player2_sos_score: prediction.player2_probability,
        player1_h2h_score: prediction.player1_probability,
        player2_h2h_score: prediction.player2_probability,
        player1_market_score: prediction.player1_probability,
        player2_market_score: prediction.player2_probability,
        player1_context_score: prediction.player1_probability,
        player2_context_score: prediction.player2_probability,
        agreement_score: prediction.confidence_score,
        data_quality_score: prediction.confidence_score,
    }, { onConflict: "match_id" });
}

async function syncAllPlayerPerformance(): Promise<void> {
    const { data: players } = await supabase.from("players").select("id, ranking");

    if (!players || players.length === 0) return;

    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().split('T')[0];
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];

    for (const player of players) {
        const { data: matches } = await supabase
            .from("matches")
            .select("id, player1_id, player2_id, winner_id, score")
            .or(`player1_id.eq.${player.id},player2_id.eq.${player.id}`)
            .eq("status", "completed")
            .not("score", "is", null)
            .limit(100);

        if (!matches || matches.length === 0) continue;

        let wins = 0, losses = 0, setsWon = 0, setsLost = 0;

        for (const m of matches) {
            const isP1 = m.player1_id === player.id;
            const playerScore = isP1 ? parseInt(m.score.split('-')[0]) : parseInt(m.score.split('-')[1]);
            const opponentScore = isP1 ? parseInt(m.score.split('-')[1]) : parseInt(m.score.split('-')[0]);

            if (playerScore > opponentScore) wins++;
            else losses++;

            setsWon += playerScore;
            setsLost += opponentScore;
        }

        const winPct = wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100, 2) : null;
        const setPct = setsWon + setsLost > 0 ? Math.round((setsWon / (setsWon + setsLost)) * 100, 2) : null;

        await supabase.from("player_performance").upsert({
            player_id: player.id,
            period_start: periodStart,
            period_end: periodEnd,
            matches_played: matches.length,
            wins,
            losses,
            sets_won: setsWon,
            sets_lost: setsLost,
            win_percentage: winPct,
            set_percentage: setPct,
            ranking_at_period: player.ranking,
            updated_at: new Date().toISOString(),
        }, { onConflict: "player_id,period_start,period_end,surface" });
    }
}

async function cleanupStaleLiveMatches(): Promise<{ cleaned: number; errors: string[] }> {
    const cutoff = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();

    const { data: stale, error: fetchError } = await supabase
        .from("matches")
        .select("id, scheduled_at, player1_id, player2_id, score")
        .eq("status", "live")
        .lt("updated_at", cutoff)
        .limit(100);

    if (fetchError) {
        return { cleaned: 0, errors: [fetchError.message] };
    }

    if (!stale || stale.length === 0) {
        return { cleaned: 0, errors: [] };
    }

    let cleaned = 0;
    const errors: string[] = [];

    for (const match of stale) {
        const { error: updateError } = await supabase
            .from("matches")
            .update({
                status: "completed",
                status_text: "Ended",
                updated_at: new Date().toISOString(),
            })
            .eq("id", match.id);

        if (updateError) {
            errors.push(`Cleanup ${match.id}: ${updateError.message}`);
        } else {
            cleaned++;
        }
    }

    return { cleaned, errors };
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
            const cleanup = await cleanupStaleLiveMatches();
            result.cleaned_live = cleanup.cleaned;
            result.cleanup_errors = cleanup.errors;
            return new Response(JSON.stringify({ status: "success", mode, result }, null, 2), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }

        if (mode === "results") {
            // Mantém compatibilidade - sincroniza tudo
            const result = await syncMatches();
            const cleanup = await cleanupStaleLiveMatches();
            result.cleaned_live = cleanup.cleaned;
            result.cleanup_errors = cleanup.errors;
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
