-- Add category column to matches table
ALTER TABLE matches ADD COLUMN IF NOT EXISTS category text;

-- Update category based on player names
UPDATE matches SET category = 'D' WHERE player1_name LIKE '%/%' OR player2_name LIKE '%/%';

-- Update category based on gender
UPDATE matches SET category = 'M' WHERE category IS NULL AND player1_id IN (SELECT id FROM players WHERE gender = 'M');
UPDATE matches SET category = 'W' WHERE category IS NULL AND player1_id IN (SELECT id FROM players WHERE gender = 'F');

-- Set remaining to ALL
UPDATE matches SET category = 'ALL' WHERE category IS NULL;

-- Create index
CREATE INDEX IF NOT EXISTS idx_matches_category ON matches(category);
