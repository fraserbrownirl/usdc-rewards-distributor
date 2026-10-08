-- 001_initial.sql — POD Miner USDC Rewards Distributor v1 ledger
-- Postgres 15+. All monetary values are NUMERIC(20,0) (u64 max = 18446744073709551615).

BEGIN;

CREATE TABLE schema_migrations (
    version     INTEGER PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rounds: one row per UTC day. Status flow: ingested -> published (or empty).
CREATE TABLE rounds (
    round                          DATE PRIMARY KEY,
    file_sha256                    TEXT NOT NULL,
    total                          NUMERIC(20,0) NOT NULL CHECK (total > 0),
    wallet_count                   INTEGER NOT NULL CHECK (wallet_count > 0),
    status                         TEXT NOT NULL CHECK (status IN ('ingested','published','empty')),
    root                           TEXT,
    publish_signature              TEXT,
    publish_slot                   BIGINT,
    publish_last_valid_block_height BIGINT,
    created_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (root IS NULL OR root ~ '^[0-9a-f]{64}$')
);

-- At most one round may be awaiting publish at a time.
CREATE UNIQUE INDEX rounds_one_ingested ON rounds (status) WHERE status = 'ingested';

-- Per-round per-wallet increments (the daily file contents).
CREATE TABLE round_rewards (
    round   DATE NOT NULL REFERENCES rounds(round) ON DELETE RESTRICT,
    wallet  TEXT NOT NULL,
    amount  NUMERIC(20,0) NOT NULL CHECK (amount > 0),
    PRIMARY KEY (round, wallet)
);

-- Cumulative lifetime totals. Never decrease (trigger below).
CREATE TABLE totals (
    wallet         TEXT PRIMARY KEY,
    total          NUMERIC(20,0) NOT NULL CHECK (total > 0),
    updated_round  DATE NOT NULL REFERENCES rounds(round) ON DELETE RESTRICT,
    claim_record   NUMERIC(20,0) NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION totals_never_decrease() RETURNS trigger AS $$
BEGIN
    IF NEW.total < OLD.total THEN
        RAISE EXCEPTION 'totals.total may never decrease (wallet %, % -> %)',
            OLD.wallet, OLD.total, NEW.total;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER totals_never_decrease
    BEFORE UPDATE ON totals
    FOR EACH ROW EXECUTE FUNCTION totals_never_decrease();

-- Trees: one row per published (or publishable) root.
CREATE TABLE trees (
    root        TEXT PRIMARY KEY CHECK (root ~ '^[0-9a-f]{64}$'),
    round       DATE NOT NULL REFERENCES rounds(round) ON DELETE RESTRICT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Proofs: concatenated 32-byte siblings per wallet per tree.
CREATE TABLE proofs (
    root    TEXT NOT NULL REFERENCES trees(root) ON DELETE CASCADE,
    wallet  TEXT NOT NULL,
    proof   BYTEA NOT NULL,
    PRIMARY KEY (root, wallet),
    CHECK (octet_length(proof) % 32 = 0)
);

CREATE INDEX proofs_root ON proofs (root);

COMMIT;
