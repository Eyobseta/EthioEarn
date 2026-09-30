CREATE TABLE users(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id bigint NOT NULL UNIQUE,
  username text, first_name text, last_name text, language_code text,
  referral_code text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);
CREATE TABLE campaigns(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL, advertiser text NOT NULL, destination_url text NOT NULL,
  reward bigint NOT NULL CHECK (reward > 0),
  total_budget bigint NOT NULL CHECK (total_budget > 0),
  spent bigint NOT NULL DEFAULT 0,
  min_seconds int NOT NULL DEFAULT 5,
  daily_user_cap int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SUBMITTED','UNDER_REVIEW','APPROVED','ACTIVE','PAUSED','EXHAUSTED','EXPIRED','REJECTED','CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (spent >= 0 AND spent <= total_budget)
);
CREATE TABLE earning_sessions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  campaign_id uuid NOT NULL REFERENCES campaigns(id),
  reward bigint NOT NULL CHECK (reward > 0),
  min_seconds int NOT NULL,
  status text NOT NULL DEFAULT 'STARTED' CHECK (status IN ('STARTED','COMPLETED')),
  started_at timestamptz NOT NULL,
  completed_at timestamptz
);
CREATE INDEX earning_sessions_user_day ON earning_sessions(user_id, completed_at);
CREATE TABLE withdrawals(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  amount bigint NOT NULL CHECK (amount > 0),
  method text NOT NULL, account jsonb NOT NULL,
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','UNDER_REVIEW','APPROVED','PROCESSING','PAID','REJECTED','CANCELLED')),
  idempotency_key text NOT NULL UNIQUE,
  provider_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ledger_transactions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id),
  campaign_id uuid REFERENCES campaigns(id),
  withdrawal_id uuid REFERENCES withdrawals(id),
  type text NOT NULL CHECK (type IN ('AD_REWARD','TASK_REWARD','REFERRAL_REWARD','BONUS','ADMIN_ADJUSTMENT','WITHDRAWAL_HOLD','WITHDRAWAL_REVERSAL','WITHDRAWAL_PAYMENT','REFUND','CAMPAIGN_CHARGE','PLATFORM_REVENUE','PROVIDER_REVENUE')),
  amount bigint NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'ETB',
  direction text NOT NULL CHECK (direction IN ('CREDIT','DEBIT')),
  status text NOT NULL DEFAULT 'POSTED' CHECK (status = 'POSTED'),
  idempotency_key text NOT NULL UNIQUE,
  reference_type text, reference_id text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_user ON ledger_transactions(user_id, created_at);
CREATE FUNCTION ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ledger_transactions is append-only; post a compensating entry'; END $$;
CREATE TRIGGER ledger_no_change BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION ledger_immutable();
