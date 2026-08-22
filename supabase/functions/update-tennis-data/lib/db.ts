import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { fetchTournament } from "./api-client.ts";
import type { ApiMatch, ApiPlayer, ApiTournament } from "./types.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
});

function normalizeCountry(country: string | null): string | null {
    if (!country) return null;
    return country.toLowerCase();
}

function normalizeHand(hand: string | null): string | null {
    if (!hand) return null;
    return hand;
}

function parseBirthDate(birthday: string | null): string | null {
    if (!birthday) return null;
    return birthday;
}

function parseBestOf(format: string | null): number | null {
    if (!format) return null;
    if (format === "BO5") return 5;
    if (format === "BO3") return 3;
    return null;
}

export async function upsertPlayer(player: ApiPlayer): Promise<{ id: number; created: boolean }> {
    const { data: existing } = await supabase
        .from("players")
        .select("id")
        .eq("api_id", player.id)
        .maybeSingle();

    const playerData = {
        api_id: player.id,
        name: player.name,
        country: normalizeCountry(player.country),
        gender: player.tour === "wta" ? "F" : "M",
        ranking: player.ranking,
        ranking_points: player.ranking_points,
        hand: normalizeHand(player.hand),
        birth_date: parseBirthDate(player.birthday),
        updated_at: new Date().toISOString(),
    };

    if (existing) {
        await supabase
            .from("players")
            .update(playerData)
            .eq("api_id", player.id);
        return { id: existing.id, created: false };
    }

    const { data: inserted, error } = await supabase
        .from("players")
        .insert(playerData)
        .select("id")
        .single();

    if (error) {
        throw new Error(`Failed to insert player ${player.id}: ${error.message}`);
    }

    return { id: inserted.id, created: true };
}

export async function upsertTournament(t: ApiTournament): Promise<{ id: number; created: boolean }> {
    const { data: existing } = await supabase
        .from("tournaments")
        .select("id")
        .eq("api_id", t.id)
        .maybeSingle();

    const tournamentData = {
        api_id: t.id,
        name: t.name,
        category: t.category,
        surface: t.surface,
        country: normalizeCountry(t.country),
        updated_at: new Date().toISOString(),
    };

    if (existing) {
        await supabase
            .from("tournaments")
            .update(tournamentData)
            .eq("api_id", t.id);
        return { id: existing.id, created: false };
    }

    const { data: inserted, error } = await supabase
        .from("tournaments")
        .insert(tournamentData)
        .select("id")
        .single();

    if (error) {
        throw new Error(`Failed to insert tournament ${t.id}: ${error.message}`);
    }

    return { id: inserted.id, created: true };
}

export async function upsertMatch(
    match: ApiMatch,
    player1DbId: number | null,
    player2DbId: number | null,
    tournamentDbId: number | null,
): Promise<{ id: number; created: boolean }> {
    const { data: existing } = await supabase
        .from("matches")
        .select("id")
        .eq("api_id", match.id)
        .maybeSingle();

    const matchData = {
        api_id: match.id,
        tournament_id: tournamentDbId,
        scheduled_at: match.scheduled_time,
        round: match.round_code ?? match.round,
        status: match.status,
        player1_id: player1DbId,
        player2_id: player2DbId,
        winner_id: null,
        score: null,
        best_of: parseBestOf(match.format),
        surface: match.surface,
        updated_at: new Date().toISOString(),
    };

    if (existing) {
        await supabase
            .from("matches")
            .update(matchData)
            .eq("api_id", match.id);
        return { id: existing.id, created: false };
    }

    const { data: inserted, error } = await supabase
        .from("matches")
        .insert(matchData)
        .select("id")
        .single();

    if (error) {
        throw new Error(`Failed to insert match ${match.id}: ${error.message}`);
    }

    return { id: inserted.id, created: true };
}

export async function getTournamentById(tournamentId: string): Promise<number | null> {
    const { data } = await supabase
        .from("tournaments")
        .select("id")
        .eq("api_id", tournamentId)
        .maybeSingle();

    return data?.id ?? null;
}

export async function fetchAndStoreTournament(tournamentId: string): Promise<number | null> {
    const { tournament, error } = await fetchTournament(tournamentId);

    if (error || !tournament) {
        console.error(`Failed to fetch tournament ${tournamentId}: ${error}`);
        return null;
    }

    const result = await upsertTournament(tournament as ApiTournament);
    return result.id;
}
