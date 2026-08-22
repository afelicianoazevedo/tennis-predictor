import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
});

export async function canMakeRequest(): Promise<boolean> {
    const { data, error } = await supabase.rpc("can_make_api_request");
    if (error) {
        console.error("quota check error:", error);
        return false;
    }
    return data === true;
}

export async function getApiUsage(date?: string): Promise<number> {
    const targetDate = date ?? new Date().toISOString().split("T")[0];
    const { data, error } = await supabase.rpc("get_api_usage", {
        p_date: targetDate,
    });
    if (error) {
        console.error("get usage error:", error);
        return 0;
    }
    return data ?? 0;
}

export async function getRemainingRequests(): Promise<number> {
    const { data, error } = await supabase.rpc("get_remaining_requests");
    if (error) {
        console.error("get remaining error:", error);
        return 0;
    }
    return data ?? 0;
}

export async function registerApiRequest(): Promise<number> {
    const { data, error } = await supabase.rpc("register_api_request");
    if (error) {
        console.error("register request error:", error);
        return -1;
    }
    return data ?? -1;
}

export async function logApiRequest(params: {
    endpoint: string;
    parameters: Record<string, unknown> | null;
    http_status: number | null;
    success: boolean;
    request_type: string;
    response_time_ms: number | null;
    error_message: string | null;
}): Promise<void> {
    const { error } = await supabase.from("api_requests").insert({
        endpoint: params.endpoint,
        parameters: params.parameters,
        http_status: params.http_status,
        success: params.success,
        request_type: params.request_type,
        response_time_ms: params.response_time_ms,
        error_message: params.error_message,
    });
    if (error) {
        console.error("log api request error:", error);
    }
}

export async function getDailyStats(): Promise<{
    requests_used: number;
    requests_remaining: number;
    requests_limit: number;
    first_game: string | null;
    last_game: string | null;
    total_games: number;
    games_live: number;
    games_completed: number;
    games_upcoming: number;
    next_sync_type: string | null;
    next_sync_at: string | null;
}> {
    const { data, error } = await supabase.rpc("get_daily_stats");
    if (error) {
        console.error("get daily stats error:", error);
        return {
            requests_used: 0,
            requests_remaining: 0,
            requests_limit: 90,
            first_game: null,
            last_game: null,
            total_games: 0,
            games_live: 0,
            games_completed: 0,
            games_upcoming: 0,
            next_sync_type: null,
            next_sync_at: null,
        };
    }
    return data;
}

export async function generateDailySchedule(): Promise<void> {
    const { error } = await supabase.rpc("generate_daily_schedule");
    if (error) {
        console.error("generate schedule error:", error);
    }
}

export async function updateSyncSchedule(
    scheduleId: number,
    status: string,
    matchesProcessed?: number,
    requestsConsumed?: number,
    errorMessage?: string,
): Promise<void> {
    const update: Record<string, unknown> = {
        status,
        updated_at: new Date().toISOString(),
    };
    if (status === "in_progress") {
        update.started_at = new Date().toISOString();
    }
    if (status === "completed" || status === "failed") {
        update.completed_at = new Date().toISOString();
    }
    if (matchesProcessed !== undefined) {
        update.matches_processed = matchesProcessed;
    }
    if (requestsConsumed !== undefined) {
        update.requests_consumed = requestsConsumed;
    }
    if (errorMessage) {
        update.error_message = errorMessage;
    }

    const { error } = await supabase
        .from("sync_schedule")
        .update(update)
        .eq("id", scheduleId);
    if (error) {
        console.error("update schedule error:", error);
    }
}
