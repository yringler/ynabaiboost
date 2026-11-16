-- Conversational edit plans (DESIGN §9.6). A validated plan is stored briefly so "Apply" sends only the token;
-- the actions are re-validated against the current intents before they run. Rows expire after 15 minutes and are
-- pruned on the user's next edit request.
CREATE TABLE edit_plans (
  id            TEXT PRIMARY KEY,                              -- the token (random, base64url)
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id       TEXT NOT NULL,
  text          TEXT NOT NULL,                                 -- the user's words (audited on apply)
  input_mode    TEXT NOT NULL CHECK (input_mode IN ('typed','browser_stt','server_stt')),
  selected_ids  TEXT NOT NULL,                                 -- JSON string[]: the scope at preview time
  summary       TEXT NOT NULL,                                 -- shown again with the apply result
  actions       TEXT NOT NULL,                                 -- JSON [{ action: EditAction, line }] (validated, ids resolved)
  versions      TEXT NOT NULL,                                 -- JSON { [intentId]: updated_at } at preview time
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  applied_at    INTEGER
);
CREATE INDEX edit_plans_user ON edit_plans(user_id, expires_at);
