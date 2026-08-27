-- Add last_verified_at to track when a match result was last verified
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS last_verified_at timestamptz;

-- Add index for faster queries
CREATE INDEX IF NOT EXISTS idx_matches_last_verified_at ON public.matches(last_verified_at);
