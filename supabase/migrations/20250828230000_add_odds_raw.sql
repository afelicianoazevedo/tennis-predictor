-- Create raw odds table for unmatched events
CREATE TABLE IF NOT EXISTS public.odds_raw (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id text NOT NULL,
    sport_key text NOT NULL,
    home_team text NOT NULL,
    away_team text NOT NULL,
    player1_odd numeric,
    player2_odd numeric,
    source text DEFAULT 'the_odds_api',
    market text DEFAULT 'match_winner',
    commence_time timestamptz,
    created_at timestamptz DEFAULT now(),
    matched boolean DEFAULT false
);

-- Index for queries
CREATE INDEX IF NOT EXISTS idx_odds_raw_sport_key ON public.odds_raw(sport_key);
CREATE INDEX IF NOT EXISTS idx_odds_raw_matched ON public.odds_raw(matched);
CREATE INDEX IF NOT EXISTS idx_odds_raw_event_id ON public.odds_raw(event_id);
