-- Add player and tournament name columns to matches table
ALTER TABLE matches ADD COLUMN IF NOT EXISTS player1_name text;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS player2_name text;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS tournament_name text;
