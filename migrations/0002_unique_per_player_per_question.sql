-- ensure exactly one answer per player per question
CREATE UNIQUE INDEX IF NOT EXISTS uniq_answer_per_q
  ON answers (room_code, question_id, player_id);
