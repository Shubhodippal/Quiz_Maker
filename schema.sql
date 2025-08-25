
-- D1 schema for quiz
CREATE TABLE IF NOT EXISTS rooms (
  code TEXT PRIMARY KEY,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL,
  name TEXT,
  email TEXT,
  phone TEXT,
  score INTEGER DEFAULT 0,
  FOREIGN KEY(room_code) REFERENCES rooms(code)
);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL,
  text TEXT NOT NULL,
  correct_option_id TEXT,
  position INTEGER,
  FOREIGN KEY(room_code) REFERENCES rooms(code)
);
CREATE TABLE IF NOT EXISTS options (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL,
  text TEXT NOT NULL,
  FOREIGN KEY(question_id) REFERENCES questions(id)
);
CREATE TABLE IF NOT EXISTS answers (
  id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL,
  question_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  option_id TEXT NOT NULL,
  first_flag INTEGER DEFAULT 0, -- 1 if first
  created_at INTEGER,
  FOREIGN KEY(room_code) REFERENCES rooms(code),
  FOREIGN KEY(question_id) REFERENCES questions(id),
  FOREIGN KEY(player_id) REFERENCES players(id)
);
