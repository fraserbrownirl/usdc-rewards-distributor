# DECISIONS.md — POD Miner USDC Rewards Distributor v1

Every unspecified detail in the build spec is resolved here, simplest option
chosen. Format: date, decision, rationale.

## 2026-10-08 — Program identity

- **Purpose:** POD Miner consumer rebates (USDC) for wallets paying for API
  use at `https://www.pod-miner.com/app`. Not affiliated with any other
  project.
- **Operator key (upgrade authority + admin + updater + job signer):**
  `FMMktQmbEQwc8yZnnTWxahy1QY7YhGzRDJnztprJwvZY`
  (`~/.config/solana/id.json` on the operator Mac).
- **security_txt:**
  - name: `POD Miner Rewards Distributor`
  - project_url: `https://www.pod-miner.com`
  - contacts: `mailto:security@pod-miner.com`
  - policy: `https://www.pod-miner.com/security` (falls back to repo URL if
    the page does not exist yet — recorded here so the on-chain value is
    stable)
  - source_code: public GitHub fork (URL recorded after push)
- **Fork repo:** public GitHub repo under `fraserbrownirl` (GPL-3.0
  retained, `LICENSE` file unchanged). URL recorded after first push.

## 2026-10-08 — Toolchain (per spec, pinned)

- Anchor CLI **0.30.1** via avm (built with rustc 1.79.0; anchor 0.30.1
  refuses rustc ≥ 1.80).
- Rust **1.79.0** via `rust-toolchain.toml` (repo root).
- Solana CLI **1.18.26** via Anza installer
  (`~/.local/share/solana/install/active_release/bin` — not on default
  PATH; export before running `anchor` / `solana`).
- Node **20.x** (fnm), Yarn **1.22.22** (corepack).
- Postgres **15** in Docker (docker-compose, no local psql needed).

## 2026-10-08 — Merkle/tree decisions (spec §5, locked by verifier)

- Leaf = `SHA256(SHA256(wallet_bytes_32 || total_u64_big_endian))` —
  matches `claim.rs` `verify_proof` (`hashv` over claimant bytes + BE u64,
  then `hashv` again).
- Pair hash = `SHA256(lo || hi)` with unsigned lexicographic ordering of
  the two 32-byte values.
- Entries sorted by raw wallet bytes; odd node promoted unchanged to the
  next level; single entry → root = leaf, empty proof.
- Proof = ordered sibling list, max 20 hashes (spec cap; tree of 1M
  wallets fits in 20 levels).
- Roots/proofs rendered as 64-char lowercase hex; amounts as decimal
  strings (BigInt) in JSON; u64 BE in the leaf.

## 2026-10-08 — Rounds, files, ledger

- `<round>` = UTC calendar date `YYYY-MM-DD`; round N+1 must be later than
  the last ingested round; same-round re-delivery of the identical file
  (sha256 match) is a no-op, otherwise rejected.
- File naming: `INBOX_DIR/<round>.json`; atomic writer (tmp + rename) on
  the producer side; ingest moves to `processed/` or `rejected/` +
  `<round>.error.txt`.
- Ledger = Postgres 15, plain SQL migrations in `migrations/`
  (numbered, applied in order, tracked in `schema_migrations`).
- Retain the 2 newest trees; never delete the tree whose root is on chain.
- `distributor run` cadence: every 15 min via scheduler (ops/
  docker-compose `scheduler` service, `*/15` cron inside the container).

## 2026-10-08 — Publish transaction (spec §9)

- ONE transaction, instructions in order:
  1. `ComputeBudget.set_compute_unit_limit(100_000)`
  2. `ComputeBudget.set_compute_unit_price(PRIORITY_FEE_MICROLAMPORTS)`
  3. `TransferChecked(round_total, 6 decimals, operator_ATA → vault)`
  4. `update_root(new_root)`
- Confirm to **finalized**; on timeout re-check on-chain root before
  assuming failure (idempotent resume).
- Skip publish if new root already on chain (round marked published with
  the existing signature looked up from history if available).

## 2026-10-08 — API / claim SDK

- API: Fastify 4, read-only, `GET` endpoints only; claimed amount read live
  at `confirmed` commitment; tree responses cached 10 s keyed by on-chain
  root.
- Claim SDK: legacy (non-versioned) transaction —
  ComputeBudget limit 200k, optional unit price, ATA CreateIdempotent for
  the claimant, then program `claim(total, proof)`. `parseClaimError`
  maps 6000–6005 to named codes; on InvalidProof wait 3 s, refetch the
  proof once, retry once.

## 2026-10-08 — Alerting

- `ALERT_WEBHOOK_URL` = generic HTTPS POST webhook (JSON body
  `{severity, code, message, context}`). Severity values: `info`,
  `warning`, `critical`. Deadline alerts: `file_missing` at 02:00 UTC,
  `publish_overdue` at 06:00 UTC; `root_mismatch` is critical and fires
  immediately.

## Open items (recorded as they are resolved)

- Public fork URL — after `gh repo create`.
- Mainnet program ID — after `anchor keys sync` (generated keypair).
- Devnet rehearsal transcript — appended to `RUNBOOK.md` after the
  14-round rehearsal.
