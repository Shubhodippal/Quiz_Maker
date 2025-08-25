-- base schema
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

-- questions.id will store a prefixed id: ROOM:qId
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL,
  text TEXT NOT NULL,
  -- correct_option_id stores prefixed id: ROOM:qId:oId
  correct_option_id TEXT,
  position INTEGER,
  FOREIGN KEY(room_code) REFERENCES rooms(code)
);

-- options.id will store a prefixed id: ROOM:qId:oId
CREATE TABLE IF NOT EXISTS options (
  id TEXT PRIMARY KEY,
  -- question_id is the prefixed question id
  question_id TEXT NOT NULL,
  text TEXT NOT NULL,
  FOREIGN KEY(question_id) REFERENCES questions(id)
);

CREATE TABLE IF NOT EXISTS answers (
  id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL,
  -- question_id is the prefixed question id
  question_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  -- option_id is the prefixed option id
  option_id TEXT NOT NULL,
  first_flag INTEGER DEFAULT 0,
  created_at INTEGER,
  FOREIGN KEY(room_code) REFERENCES rooms(code),
  FOREIGN KEY(question_id) REFERENCES questions(id),
  FOREIGN KEY(player_id) REFERENCES players(id)
);
