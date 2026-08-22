import { fetchUpcomingMatches } from "../lib/api-client.ts";
import { upsertPlayer, upsertTournament, getTournamentById, fetchAndStoreTournament, upsertMatch } from "../lib/db.ts";
import { canMakeRequest, getRemainingRequests, getDailyStats, generateDailySchedule } from "../lib/quota.ts";
import type { ApiMatch, SyncResult } from "../lib/types.ts";

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

    const today = new Date().toISOString().split("T")[0];
    const { matches, error } = await fetchUpcomingMatches(today, today);

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

async function runTest(): Promise<void> {
    console.log("=== Tennis Predictor - Sync Test ===\n");

    const canProceed = await canMakeRequest();
    if (!canProceed) {
        console.error("ERROR: API quota check failed");
        const stats = await getDailyStats();
        console.log("Stats:", JSON.stringify(stats, null, 2));
        Deno.exit(1);
    }

    const statsBefore = await getDailyStats();
    console.log(`Requests used today: ${statsBefore.requests_used}/${statsBefore.requests_limit}`);
    console.log(`Remaining: ${statsBefore.requests_remaining}`);
    console.log(`Games today: ${statsBefore.total_games} (${statsBefore.games_live} live, ${statsBefore.games_completed} completed, ${statsBefore.games_upcoming} upcoming)`);
    if (statsBefore.first_game) {
        console.log(`First game: ${statsBefore.first_game}`);
    }
    if (statsBefore.last_game) {
        console.log(`Last game: ${statsBefore.last_game}`);
    }
    if (statsBefore.next_sync_type) {
        console.log(`Next sync: ${statsBefore.next_sync_type} at ${statsBefore.next_sync_at}`);
    }
    console.log("");

    const mode = Deno.args[0] ?? "morning";
    let result: SyncResult;

    if (mode === "live") {
        result = await runLivePoll();
    } else {
        result = await runMorningSync();
    }

    console.log("\n=== Results ===");
    console.log(`Matches found:       ${result.matches_found}`);
    console.log(`Players created:     ${result.players_created}`);
    console.log(`Players updated:     ${result.players_updated}`);
    console.log(`Tournaments created: ${result.tournaments_created}`);
    console.log(`Tournaments updated: ${result.tournaments_updated}`);
    console.log(`Matches created:     ${result.matches_created}`);
    console.log(`Matches updated:     ${result.matches_updated}`);
    console.log(`Errors:              ${result.errors.length}`);

    if (result.errors.length > 0) {
        console.log("\nErrors:");
        for (const err of result.errors) {
            console.log(`  - ${err}`);
        }
    }

    const remaining = await getRemainingRequests();
    console.log(`\nRemaining requests: ${remaining}`);
}

await runTest();
