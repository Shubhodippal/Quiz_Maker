-- Add warning system for players who minimize screen or switch tabs
-- Players are banned after 4 warnings (changed from 3)
CREATE TABLE IF NOT EXISTS player_warnings (
  id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL,
  player_id TEXT NOT NULL,
  player_email TEXT NOT NULL,
  player_phone TEXT NOT NULL,
  warning_type TEXT NOT NULL, -- 'visibility_change' (tab switch, minimize, navigate away)
  warning_count INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(room_code) REFERENCES rooms(code),
  FOREIGN KEY(player_id) REFERENCES players(id)
);

-- Add banned players table
CREATE TABLE IF NOT EXISTS banned_players (
  id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL,
  player_id TEXT NOT NULL,
  player_email TEXT NOT NULL,
  player_phone TEXT NOT NULL,
  ban_reason TEXT DEFAULT 'excessive_warnings',
  warning_count INTEGER DEFAULT 4,
  banned_at INTEGER NOT NULL,
  FOREIGN KEY(room_code) REFERENCES rooms(code),
  FOREIGN KEY(player_id) REFERENCES players(id)
);

-- Index for quick warning lookups
CREATE INDEX IF NOT EXISTS idx_player_warnings_lookup ON player_warnings(room_code, player_id);
CREATE INDEX IF NOT EXISTS idx_player_warnings_email ON player_warnings(room_code, player_email);
CREATE INDEX IF NOT EXISTS idx_player_warnings_phone ON player_warnings(room_code, player_phone);

-- Index for banned players lookups
CREATE INDEX IF NOT EXISTS idx_banned_players_lookup ON banned_players(room_code, player_id);
CREATE INDEX IF NOT EXISTS idx_banned_players_email ON banned_players(room_code, player_email);
CREATE INDEX IF NOT EXISTS idx_banned_players_phone ON banned_players(room_code, player_phone);
CREATE INDEX IF NOT EXISTS idx_banned_players_combined ON banned_players(room_code, player_email, player_phone);