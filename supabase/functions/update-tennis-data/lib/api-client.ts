import { canMakeRequest, registerApiRequest, logApiRequest } from "./quota.ts";
import type { ApiResponse } from "./types.ts";

const API_BASE = "https://api.livetennisapi.com/api/public/v1";
const API_KEY = Deno.env.get("LIVE_TENNIS_API_KEY") ?? "";

const MIN_REQUEST_INTERVAL_MS = 2500;
let lastRequestTime = 0;

async function rateLimitDelay(): Promise<void> {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < MIN_REQUEST_INTERVAL_MS) {
        await new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed));
    }
    lastRequestTime = Date.now();
}

interface FetchOptions {
    method?: string;
    params?: Record<string, string | number | undefined>;
}

export async function apiFetch<T>(
    endpoint: string,
    options: FetchOptions = {},
): Promise<{ data: T | null; status: number; error: string | null }> {
    const requestType = endpoint.split("/")[1] || "unknown";

    const canProceed = await canMakeRequest();
    if (!canProceed) {
        return {
            data: null,
            status: 429,
            error: "API quota exhausted (90/day operational limit reached)",
        };
    }

    await rateLimitDelay();

    const url = new URL(`${API_BASE}${endpoint}`);
    if (options.params) {
        for (const [key, value] of Object.entries(options.params)) {
            if (value !== undefined) {
                url.searchParams.set(key, String(value));
            }
        }
    }

    const headers: Record<string, string> = {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
    };

    const startTime = Date.now();
    let response: Response;
    let responseTime: number;

    try {
        response = await fetch(url.toString(), {
            method: options.method ?? "GET",
            headers,
        });
        responseTime = Date.now() - startTime;
    } catch (e) {
        responseTime = Date.now() - startTime;
        await logApiRequest({
            endpoint,
            parameters: options.params ?? null,
            http_status: null,
            success: false,
            request_type: requestType,
            response_time_ms: responseTime,
            error_message: String(e),
        });
        return {
            data: null,
            status: 0,
            error: `Network error: ${String(e)}`,
        };
    }

    const currentUsage = await registerApiRequest();

    if (!response.ok) {
        const errorText = await response.text();
        await logApiRequest({
            endpoint,
            parameters: options.params ?? null,
            http_status: response.status,
            success: false,
            request_type: requestType,
            response_time_ms: responseTime,
            error_message: errorText,
        });
        return {
            data: null,
            status: response.status,
            error: `HTTP ${response.status}: ${errorText}`,
        };
    }

    const json = await response.json();

    await logApiRequest({
        endpoint,
        parameters: options.params ?? null,
        http_status: response.status,
        success: true,
        request_type: requestType,
        response_time_ms: responseTime,
        error_message: null,
    });

    return {
        data: json as T,
        status: response.status,
        error: null,
    };
}

export async function fetchUpcomingMatches(
    fromDate: string,
    toDate: string,
): Promise<{ matches: ApiResponse<unknown> | null; error: string | null }> {
    const result = await apiFetch<ApiResponse<unknown>>("/matches", {
        params: {
            status: "upcoming",
            from: fromDate,
            to: toDate,
            limit: 200,
        },
    });

    if (result.error) {
        return { matches: null, error: result.error };
    }

    return { matches: result.data, error: null };
}

export async function fetchPlayer(
    playerId: number,
): Promise<{ player: unknown | null; error: string | null }> {
    const result = await apiFetch<unknown>(`/players/${playerId}`);

    if (result.error) {
        return { player: null, error: result.error };
    }

    return { player: result.data, error: null };
}

export async function fetchTournament(
    tournamentId: string,
): Promise<{ tournament: unknown | null; error: string | null }> {
    const result = await apiFetch<unknown>(`/tournaments/${tournamentId}`);

    if (result.error) {
        return { tournament: null, error: result.error };
    }

    return { tournament: result.data, error: null };
}
