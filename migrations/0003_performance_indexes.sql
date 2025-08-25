-- Performance indexes for handling 500+ concurrent users
-- These indexes are critical for fast lookups during answer submission bursts

-- Index for player lookups by room
CREATE INDEX IF NOT EXISTS idx_players_room_code ON players(room_code);
CREATE INDEX IF NOT EXISTS idx_players_room_score ON players(room_code, score DESC);

-- Index for questions by room and position
CREATE INDEX IF NOT EXISTS idx_questions_room_position ON questions(room_code, position);

-- Index for options by question
CREATE INDEX IF NOT EXISTS idx_options_question_id ON options(question_id);

-- Critical indexes for answers table (high write volume during quiz)
CREATE INDEX IF NOT EXISTS idx_answers_room_question ON answers(room_code, question_id);
CREATE INDEX IF NOT EXISTS idx_answers_player_question ON answers(player_id, question_id);
CREATE INDEX IF NOT EXISTS idx_answers_room_question_created ON answers(room_code, question_id, created_at);

-- Composite index for duplicate answer checking (prevents multiple answers)
CREATE UNIQUE INDEX IF NOT EXISTS idx_answers_unique_per_player_question 
ON answers(room_code, question_id, player_id);
