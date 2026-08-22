import { fetchUpcomingMatches } from "./lib/api-client.ts";
import { upsertPlayer, upsertTournament, getTournamentById, fetchAndStoreTournament, upsertMatch } from "./lib/db.ts";
import {
    canMakeRequest,
    getRemainingRequests,
    getDailyStats,
    generateDailySchedule,
    updateSyncSchedule,
} from "./lib/quota.ts";
import type { ApiMatch, SyncResult } from "./lib/types.ts";

function getDateRange(daysAhead: number): { from: string; to: string } {
    const now = new Date();
    const from = now.toISOString().split("T")[0];
    const toDate = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
    const to = toDate.toISOString().split("T")[0];
    return { from, to };
}

async function processMatch(match: ApiMatch, result: SyncResult): Promise<void> {
    try {
        let player1DbId: number | null = null;
        let player2DbId: number | null = null;

        if (match.players?.p1) {
            const p1Result = await upsertPlayer(match.players.p1);
            player1DbId = p1Result.id;
            if (p1Result.created) result.players_created++;
            else result.players_updated++;
        }

        if (match.players?.p2) {
            const p2Result = await upsertPlayer(match.players.p2);
            player2DbId = p2Result.id;
            if (p2Result.created) result.players_created++;
            else result.players_updated++;
        }

        let tournamentDbId: number | null = null;
        if (match.tournament_id) {
            const existing = await getTournamentById(match.tournament_id);
            if (existing) {
                tournamentDbId = existing;
                result.tournaments_updated++;
            } else {
                const newId = await fetchAndStoreTournament(match.tournament_id);
                if (newId) {
                    tournamentDbId = newId;
                    result.tournaments_created++;
                }
            }
        }

        const matchResult = await upsertMatch(match, player1DbId, player2DbId, tournamentDbId);
        if (matchResult.created) result.matches_created++;
        else result.matches_updated++;
    } catch (e) {
        const msg = `Error processing match ${match.id}: ${String(e)}`;
        console.error(msg);
        result.errors.push(msg);
    }
}

async function syncUpcomingMatches(daysAhead: number = 3): Promise<SyncResult> {
    const result: SyncResult = {
        matches_found: 0,
        players_created: 0,
        players_updated: 0,
        tournaments_created: 0,
        tournaments_updated: 0,
        matches_created: 0,
        matches_updated: 0,
        requests_consumed: 0,
        errors: [],
    };

    const { from, to } = getDateRange(daysAhead);
    console.log(`Syncing matches from ${from} to ${to}`);

    const { matches, error } = await fetchUpcomingMatches(from, to);

    if (error) {
        result.errors.push(`Failed to fetch matches: ${error}`);
        return result;
    }

    if (!matches || !matches.data || !Array.isArray(matches.data)) {
        result.errors.push("No matches data returned from API");
        return result;
    }

    const matchList = matches.data as ApiMatch[];
    result.matches_found = matchList.length;
    console.log(`Found ${matchList.length} matches`);

    for (const match of matchList) {
        await processMatch(match, result);
    }

    return result;
}

async function runMorningSync(): Promise<SyncResult> {
    console.log("=== Morning Sync ===");
    const result = await syncUpcomingMatches(3);

    if (result.errors.length === 0) {
        await generateDailySchedule();
        console.log("Daily schedule generated");
    }

    return result;
}

async function runPreGameSync(): Promise<SyncResult> {
    console.log("=== Pre-Game Sync ===");
    return await syncUpcomingMatches(1);
}

async function runLivePoll(): Promise<SyncResult> {
    console.log("=== Live Poll ===");
    const result: SyncResult = {
        matches_found: 0,
        players_created: 0,
        players_updated: 0,
        tournaments_created: 0,
        tournaments_updated: 0,
        matches_created: 0,
        matches_updated: 0,
        requests_consumed: 0,
        errors: [],
    };

    const { matches, error } = await fetchUpcomingMatches(
        new Date().toISOString().split("T")[0],
        new Date().toISOString().split("T")[0],
    );

    if (error) {
        result.errors.push(`Live poll failed: ${error}`);
        return result;
    }

    if (!matches?.data || !Array.isArray(matches.data)) {
        return result;
    }

    const matchList = matches.data as ApiMatch[];
    result.matches_found = matchList.length;

    for (const match of matchList) {
        if (match.status === "live" || match.status === "completed") {
            await processMatch(match, result);
        }
    }

    return result;
}

async function runPostGameSync(): Promise<SyncResult> {
    console.log("=== Post-Game Sync ===");
    return await syncUpcomingMatches(1);
}

Deno.serve(async (req: Request) => {
    const url = new URL(req.url);
    const mode = url.searchParams.get("mode") ?? "auto";

    if (req.method !== "GET" && req.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
            status: 405,
            headers: { "Content-Type": "application/json" },
        });
    }

    try {
        const canProceed = await canMakeRequest();
        if (!canProceed) {
            const stats = await getDailyStats();
            return new Response(
                JSON.stringify({
                    status: "rate_limited",
                    message: "API quota check failed - too many requests",
                    stats,
                }),
                {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                },
            );
        }

        let result: SyncResult;
        let syncType: string;

        if (mode === "morning") {
            result = await runMorningSync();
            syncType = "morning_sync";
        } else if (mode === "pre_game") {
            result = await runPreGameSync();
            syncType = "pre_game";
        } else if (mode === "live") {
            result = await runLivePoll();
            syncType = "live_poll";
        } else if (mode === "post_game") {
            result = await runPostGameSync();
            syncType = "post_game";
        } else {
            result = await runMorningSync();
            syncType = "morning_sync";
        }

        const remaining = await getRemainingRequests();
        const stats = await getDailyStats();

        return new Response(
            JSON.stringify({
                status: "success",
                sync_type: syncType,
                result,
                remaining_requests: remaining,
                stats,
            }, null, 2),
            {
                status: 200,
                headers: { "Content-Type": "application/json" },
            },
        );
    } catch (e) {
        return new Response(
            JSON.stringify({ error: String(e) }),
            {
                status: 500,
                headers: { "Content-Type": "application/json" },
            },
        );
    }
});
