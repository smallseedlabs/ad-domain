-- H1-02: Transactional budget ledger and per-goal caps.
CREATE TABLE IF NOT EXISTS ads.goal_budget_caps (
  workspace_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  lifetime_cap_usd NUMERIC(14, 4) NOT NULL,
  daily_cap_usd NUMERIC(14, 4) NOT NULL,
  max_live_campaigns INTEGER NOT NULL DEFAULT 2,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, goal_id)
);

CREATE TABLE IF NOT EXISTS ads.budget_ledger (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  campaign_id TEXT,
  platform TEXT,
  kind TEXT NOT NULL,
  amount_usd NUMERIC(14, 4) NOT NULL,
  daily_allocation_usd NUMERIC(14, 4) NOT NULL DEFAULT 0,
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key, kind)
);

CREATE INDEX IF NOT EXISTS idx_budget_ledger_workspace_goal
  ON ads.budget_ledger (workspace_id, goal_id, created_at);
