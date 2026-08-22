export interface ApiPlayer {
    id: number;
    name: string;
    tour: string | null;
    country: string | null;
    ranking: number | null;
    ranking_points: number | null;
    ranking_movement: string | null;
    hand: string | null;
    backhand: number | null;
    birthday: string | null;
    is_doubles_team: boolean;
}

export interface ApiMatch {
    id: number;
    tournament: string;
    tour: string | null;
    tournament_id: string | null;
    surface: string | null;
    indoor: boolean;
    format: string | null;
    round: string | null;
    round_code: string | null;
    status: string;
    event_status: string | null;
    scheduled_time: string | null;
    is_doubles: boolean;
    draw: string | null;
    players: {
        p1: ApiPlayer;
        p2: ApiPlayer;
    };
    score: unknown;
    winner: number | null;
}

export interface ApiTournament {
    id: string;
    name: string | null;
    tour: string | null;
    surface: string | null;
    indoor: boolean;
    city: string | null;
    country: string | null;
    category: string | null;
}

export interface ApiResponse<T> {
    data: T;
    meta: {
        limit: number;
        offset: number;
        count: number;
        total: number | null;
        has_more: boolean;
    };
}

export interface ApiUsage {
    date: string;
    requests_used: number;
    requests_reserved: number;
    last_request_at: string | null;
}

export interface SyncResult {
    matches_found: number;
    players_created: number;
    players_updated: number;
    tournaments_created: number;
    tournaments_updated: number;
    matches_created: number;
    matches_updated: number;
    requests_consumed: number;
    errors: string[];
}
