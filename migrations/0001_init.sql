-- Migration 0001: initial schema (DESIGN.md §5). Times: epoch ms; dates: YYYY-MM-DD; money: integer milliunits.
-- ── identity ────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id                        TEXT PRIMARY KEY,                -- YNAB user id (access is decided by vars, D16)
  auth_type                 TEXT NOT NULL CHECK (auth_type IN ('oauth','pat')),
  stt_allowed               INTEGER NOT NULL DEFAULT 0,
  needs_reauth              INTEGER NOT NULL DEFAULT 0,
  token_refresh_lock_until  INTEGER,                         -- OAuth refresh mutex (epoch ms)
  created_at                INTEGER NOT NULL,
  last_seen_at              INTEGER NOT NULL
);

CREATE TABLE sessions (
  id_hash       TEXT PRIMARY KEY,                            -- hex SHA-256 of cookie token
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  user_agent    TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE user_secrets (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('ynab_access','ynab_refresh','ynab_pat','anthropic')),
  sealed      TEXT NOT NULL,                                 -- "v1.<iv_b64url>.<ct_b64url>", AAD = user_id||':'||kind
  expires_at  INTEGER,                                       -- ynab_access only
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind)
);

CREATE TABLE user_settings (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  json        TEXT NOT NULL,                                 -- validated by SettingsShape (shared)
  updated_at  INTEGER NOT NULL
);

-- ── YNAB sync state & cache ────────────────────────────────────────────────
CREATE TABLE sync_state (
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id            TEXT NOT NULL,
  plan_name          TEXT,
  currency_iso       TEXT NOT NULL DEFAULT 'USD',
  currency_decimals  INTEGER NOT NULL DEFAULT 2,
  server_knowledge   INTEGER,                                -- NULL => initial sync needed
  last_sync_at       INTEGER,
  last_cycle_at      INTEGER,
  last_error         TEXT,                                   -- "<ErrorCode>: <message>", NULL after a clean cycle
  rate_limited_until INTEGER,                                -- set after a YNAB 429; cycles skip until then
  lock_until         INTEGER,                                -- cycle mutex (epoch ms)
  PRIMARY KEY (user_id, plan_id)
);

CREATE TABLE ynab_category_groups (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id      TEXT NOT NULL,
  id           TEXT NOT NULL,
  name         TEXT NOT NULL,
  hidden       INTEGER NOT NULL DEFAULT 0,
  deleted      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE ynab_categories (                               -- group name/hidden/internal/cc are JOINed at query time
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id      TEXT NOT NULL,
  id           TEXT NOT NULL,
  group_id     TEXT NOT NULL,
  name         TEXT NOT NULL,
  hidden       INTEGER NOT NULL DEFAULT 0,                   -- the category's own flag only
  deleted      INTEGER NOT NULL DEFAULT 0,
  sort_index   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX ynab_categories_plan ON ynab_categories(user_id, plan_id);
-- effective hidden = c.hidden OR g.hidden; internal = g.name = 'Internal Master Category';
-- cc_payment = g.name = 'Credit Card Payments'  (both verified in spike S1)

CREATE TABLE ynab_accounts (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id    TEXT NOT NULL,
  id         TEXT NOT NULL,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,
  on_budget  INTEGER NOT NULL,
  direct_import_linked INTEGER NOT NULL DEFAULT 0,           -- AccountBase.direct_import_linked; 0 => final entries (§10.7)
  closed     INTEGER NOT NULL DEFAULT 0,
  deleted    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE ynab_payees (
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id              TEXT NOT NULL,
  id                   TEXT NOT NULL,
  name                 TEXT NOT NULL,
  transfer_account_id  TEXT,
  deleted              INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE ynab_transactions (                             -- rolling ~120-day window
  user_id                     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id                     TEXT NOT NULL,
  id                          TEXT NOT NULL,
  date                        TEXT NOT NULL,
  amount                      INTEGER NOT NULL,              -- YNAB-signed milliunits
  payee_id                    TEXT,
  payee_name                  TEXT,
  import_payee_name           TEXT,
  import_payee_name_original  TEXT,
  account_id                  TEXT NOT NULL,
  category_id                 TEXT,
  memo                        TEXT,
  cleared                     TEXT NOT NULL,
  approved                    INTEGER NOT NULL,
  flag_color                  TEXT,
  import_id                   TEXT,
  matched_transaction_id      TEXT,
  transfer_account_id         TEXT,
  is_split                    INTEGER NOT NULL DEFAULT 0,
  deleted                     INTEGER NOT NULL DEFAULT 0,
  updated_at                  INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX ynab_txn_plan_date ON ynab_transactions(user_id, plan_id, date);
CREATE INDEX ynab_txn_matched   ON ynab_transactions(user_id, matched_transaction_id);

-- ── intents ─────────────────────────────────────────────────────────────────
CREATE TABLE intents (
  id                    TEXT PRIMARY KEY,                    -- uuid
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id               TEXT NOT NULL,
  short_ref             TEXT NOT NULL,                       -- 6 chars, memo tag [aib:XXXXXX]
  status                TEXT NOT NULL CHECK (status IN ('pending','partial','review','resolved','cancelled')),
  raw_text              TEXT NOT NULL,
  input_mode            TEXT NOT NULL CHECK (input_mode IN ('typed','browser_stt','server_stt')),
  payee                 TEXT NOT NULL,
  payee_id              TEXT,
  merchant_kind         TEXT NOT NULL CHECK (merchant_kind IN ('amazon','online','in_person','other')),
  direction             TEXT NOT NULL CHECK (direction IN ('outflow','inflow')),
  intent_date           TEXT NOT NULL,
  account_id            TEXT,
  account_explicit      INTEGER NOT NULL DEFAULT 0,          -- user named the account
  total_amount          INTEGER NOT NULL,                    -- positive milliunits
  tolerance             INTEGER NOT NULL,                    -- milliunits
  approximate           INTEGER NOT NULL,
  precision             TEXT NOT NULL DEFAULT 'approximate' CHECK (precision IN ('exact','approximate')),
                                                             -- deterministic (shared/precision.ts), never the model's say-so
  precision_note        TEXT,                                -- user-facing reason / clarity note
  order_facts           TEXT,                                -- JSON OrderFacts as Claude reported them (unverified)
  order_plan            TEXT,                                -- JSON OrderPlan (verified Amazon facts) or NULL
  memo                  TEXT,
  placeholder_txn_id    TEXT,
  placeholder_status    TEXT NOT NULL DEFAULT 'none'
                        CHECK (placeholder_status IN ('none','created','auto_matched','deleted','missing','failed','final')),
                                                             -- 'final' = final entry or "Keep as final"; never matched or deleted
  placeholder_amount    INTEGER,                             -- positive milliunits currently on YNAB
  expires_on            TEXT NOT NULL,                       -- stale after this date
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  resolved_at           INTEGER,
  UNIQUE (user_id, short_ref)
);
CREATE INDEX intents_user_status ON intents(user_id, status);

CREATE TABLE intent_lines (
  id              TEXT PRIMARY KEY,
  intent_id       TEXT NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
  idx             INTEGER NOT NULL,
  description     TEXT NOT NULL,
  category_id     TEXT NOT NULL,
  amount          INTEGER NOT NULL,                          -- positive milliunits (estimate)
  tolerance       INTEGER NOT NULL,
  approximate     INTEGER NOT NULL,
  exact           INTEGER NOT NULL DEFAULT 0,                -- amount literally in the user's text (tight tolerance)
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','matched')),
  matched_txn_id  TEXT,
  UNIQUE (intent_id, idx)
);

-- ── matching / review / audit ──────────────────────────────────────────────
CREATE TABLE matches (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  intent_id     TEXT NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
  ynab_txn_id   TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('ynab_auto','single','split','amazon_subset','manual','review')),
  line_ids      TEXT NOT NULL,                               -- JSON string[]
  allocation    TEXT NOT NULL,                               -- JSON {categoryId, amount, memo}[] (signed)
  score         REAL,
  state         TEXT NOT NULL CHECK (state IN ('planned','applied','failed')),
  error         TEXT,
  created_at    INTEGER NOT NULL,
  applied_at    INTEGER
);
CREATE UNIQUE INDEX matches_txn_live ON matches(user_id, ynab_txn_id) WHERE state IN ('planned','applied');
CREATE INDEX matches_intent ON matches(intent_id);

CREATE TABLE reviews (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  intent_id     TEXT REFERENCES intents(id) ON DELETE CASCADE,  -- owner intent; NULL for a cross-intent review (§10.6)
  ynab_txn_id   TEXT,                                          -- set for cross-intent and txn-centred reviews
  kind          TEXT NOT NULL CHECK (kind IN ('ambiguous_match','amazon_split','ynab_matched_other','split_conflict','too_complex','approved_import')),
  options       TEXT NOT NULL,                               -- JSON ReviewOption[] (shared schema)
  summary       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  created_at    INTEGER NOT NULL,
  resolved_at   INTEGER
);
CREATE UNIQUE INDEX reviews_open_intent ON reviews(user_id, intent_id) WHERE status = 'open' AND intent_id IS NOT NULL;
CREATE UNIQUE INDEX reviews_open_txn    ON reviews(user_id, ynab_txn_id) WHERE status = 'open' AND intent_id IS NULL;
-- Every intent that appears in an open review's options has intents.status='review' (owner or not).
-- The engine never puts an intent into a second open review (it checks openReviewIntentIds).

CREATE TABLE audit_log (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at           INTEGER NOT NULL,
  actor        TEXT NOT NULL CHECK (actor IN ('user','cron','app')),
  action       TEXT NOT NULL,                                -- AuditAction (shared)
  summary      TEXT NOT NULL,
  intent_id    TEXT,
  ynab_txn_id  TEXT,
  before_json  TEXT,                                         -- TxnSnapshot (§6.2) for txn writes, else NULL
  after_json   TEXT                                          -- TxnSnapshot (§6.2) for txn writes, else NULL
);
CREATE INDEX audit_user_at ON audit_log(user_id, at);
