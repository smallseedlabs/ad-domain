-- Isolated Ads-domain schema. Additive only. No DOWN. Does not touch Hub/Context/Memory tables.
CREATE SCHEMA IF NOT EXISTS ads;

CREATE TABLE IF NOT EXISTS ads.schema_migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ads.commands (
  workspace_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  verb TEXT NOT NULL,
  request JSONB NOT NULL,
  status TEXT NOT NULL,
  result JSONB,
  campaign_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS ads_commands_status_idx ON ads.commands (status) WHERE status IN ('pending', 'in_flight', 'ambiguous');

CREATE TABLE IF NOT EXISTS ads.campaigns (
  workspace_id TEXT NOT NULL,
  proba_campaign_id UUID NOT NULL,
  user_id UUID NOT NULL,
  goal_id UUID,
  name TEXT NOT NULL,
  landing_page_url TEXT NOT NULL,
  daily_budget NUMERIC(20,6) NOT NULL,
  currency CHAR(3) NOT NULL,
  platform TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  lock_command_key TEXT,
  provider TEXT,
  provider_account_id TEXT,
  provider_campaign_id TEXT,
  provider_ad_group_id TEXT,
  provider_ad_id TEXT,
  reconcile JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, proba_campaign_id)
);

CREATE INDEX IF NOT EXISTS ads_campaigns_workspace_idx ON ads.campaigns (workspace_id);

CREATE TABLE IF NOT EXISTS ads.provider_accounts (
  workspace_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  account_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, platform, account_id)
);

-- Transactional outbox in this service's schema. Relay publishes protocol
-- AuditEvents to Redis stream proba.audit.events. Replay never executes commands.
CREATE TABLE IF NOT EXISTS ads.audit_outbox (
  id           BIGSERIAL PRIMARY KEY,
  event_id     UUID        NOT NULL UNIQUE,
  payload      JSONB       NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ,
  attempts     INTEGER     NOT NULL DEFAULT 0,
  last_error   TEXT,
  published_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ads_audit_outbox_pending_idx ON ads.audit_outbox (id) WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS ads_audit_outbox_published_idx ON ads.audit_outbox (published_at) WHERE published_at IS NOT NULL;
