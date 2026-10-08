-- 001_initial.sql — POD Miner USDC Rewards Distributor v1 ledger (spec §7)
-- Postgres 15+. Amounts NUMERIC(20,0) (u64 max = 18446744073709551615);
-- wallets base58 TEXT; hashes 64-char lowercase hex TEXT.
-- Runs inside a transaction managed by the migrator (db.migrate), which also
-- owns the schema_migrations bookkeeping table.

-- One row per UTC round. Status flow: ingested -> published, or empty.
CREATE TABLE rounds (
    round                          DATE PRIMARY KEY,
    file_sha256                    TEXT NOT NULL,
    total                          NUMERIC(20,0) NOT NULL CHECK (total >= 0),
    wallet_count                   INTEGER NOT NULL CHECK (wallet_count >= 0),
    status                         TEXT NOT NULL CHECK (status IN ('ingested','published','empty')),
    root                           TEXT,
    publish_signature              TEXT,
    publish_slot                   BIGINT,
    publish_last_valid_block_height BIGINT,
    ingested_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at                   TIMESTAMPTZ,
    CHECK (root IS NULL OR root ~ '^[0-9a-f]{64}$'),
    CHECK ((status = 'empty') = (total = 0))
);

-- At most one round may be awaiting publish at a time.
CREATE UNIQUE INDEX rounds_one_ingested ON rounds (status) WHERE status = 'ingested';

-- The file's rows, kept for history and audit.
CREATE TABLE round_rewards (
    round   DATE NOT NULL REFERENCES rounds(round) ON DELETE RESTRICT,
    wallet  TEXT NOT NULL,
    amount  NUMERIC(20,0) NOT NULL CHECK (amount > 0),
    PRIMARY KEY (round, wallet)
);

-- Lifetime total per wallet. claim_record holds the wallet's derived
-- ClaimedRewards PDA address, set on first insert. Rows are never deleted
-- and total never decreases (trigger).
CREATE TABLE totals (
    wallet         TEXT PRIMARY KEY,
    total          NUMERIC(20,0) NOT NULL CHECK (total > 0),
    updated_round  DATE NOT NULL REFERENCES rounds(round) ON DELETE RESTRICT,
    claim_record   TEXT NOT NULL
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

-- One row per built tree. total_sum / wallet_count are snapshots of the
-- totals table at build time (invariant 2).
CREATE TABLE trees (
    root         TEXT PRIMARY KEY CHECK (root ~ '^[0-9a-f]{64}$'),
    round        DATE NOT NULL REFERENCES rounds(round) ON DELETE RESTRICT,
    wallet_count INTEGER NOT NULL CHECK (wallet_count > 0),
    total_sum    NUMERIC(20,0) NOT NULL CHECK (total_sum > 0),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-wallet proof per tree: total plus concatenated 32-byte sibling
-- hashes, bottom to top.
CREATE TABLE proofs (
    root    TEXT NOT NULL REFERENCES trees(root) ON DELETE CASCADE,
    wallet  TEXT NOT NULL,
    total   NUMERIC(20,0) NOT NULL CHECK (total > 0),
    proof   BYTEA NOT NULL,
    PRIMARY KEY (root, wallet),
    CHECK (octet_length(proof) % 32 = 0)
);

CREATE INDEX proofs_root ON proofs (root);
