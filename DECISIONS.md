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

## 2026-10-08 — Spec-conformance rework (daily job + API + SDK)

- **Invariant 2 skip during a pending round:** invariant 2 (newest tree
  matches `totals`) is only checked when NO round sits in status
  `ingested`. With a round awaiting publish, `totals` legitimately leads
  the newest tree (e.g. a previous run stopped between ingest and
  storeTree) — the job must resume, not halt on a false positive.
- **Deadline-alert dedupe via state file:** the scheduler spawns a fresh
  `distributor run` per tick, so in-process dedupe never survives.
  `.alert-state.json` in `INBOX_DIR` records which deadline alerts fired
  per UTC day; survives restarts.
- **Reconcile is best-effort at job end (step 11):** a reconcile failure
  or crash logs + alerts (`publish_failed`) but does not undo a
  successful publish or change the exit code — reconciling is a monitor,
  not a gate. Solvency/overclaim findings themselves are critical alerts.
- **Reconcile model (spec §8):** B = vault balance, C = Σ claimed across
  claim records (`getProgramAccounts`, dataSize 32 + ClaimedRewards
  account discriminator `[105,246,152,121,249,99,139,216]`), F = Σ
  published round totals. B + C < F → solvency critical; surplus → info.
  The vault is re-read around the claim-record scan (≤5 attempts) so a
  mid-scan claim can't produce a phantom shortfall.
- **Empty-day rounds are valid input** (spec §6): `total "0"`, `count 0`,
  `rewards []` validates and ingests as status `empty` — the day is
  recorded (so `publish_overdue` stays quiet) with no tree or publish.
- **export-outstanding targets the on-chain root's tree**, with
  outstanding = tree total − live on-chain claimed per wallet — i.e. the
  exact claimable set if the program were wound down now.
- **`admin initialize` is a CLI subcommand** (spec §13): builds the
  initialize instruction hand-rolled (sighash
  `[175,175,109,31,13,152,155,237]`), enforcing the on-chain constraint
  that `program_data.upgrade_authority == admin` (operator key).

## 2026-10-08 — Toolchain: nightly-2025-03-01 for the IDL build

- **Root cause of "Error: Building IDL failed":** `anchor build`/`anchor
  idl build` delegates to `anchor-lang-idl`, which compiles the IDL via
  `cargo +nightly test __anchor_private_print_idl --features idl-build`
  with `RUSTFLAGS=--cfg procmacro2_semver_exempt`. Two host crates then
  fail on the too-new default nightly (1.101.0):
  - `anchor-syn 0.30.1` calls `proc_macro2::Span::call_site().source_file()`
    (idl/defined.rs:499), which maps to `proc_macro::Span::source_file()` —
    **removed** (renamed `source()`) in recent nightlies.
  - proc-macro2 ≤1.0.94 uses `proc_macro::SourceFile` / `Span::source_file()`
    in its semver-exempt path — also removed (E0425/E0599).
- **Fix (operator-directed, no bisecting):** pin the IDL toolchain to
  **nightly-2025-03-01** (rustc 1.87.0-nightly), from the same era as the
  upstream repo and predating the `source_file` removal:
  `RUSTUP_TOOLCHAIN=nightly-2025-03-01 anchor idl build …`.
  `anchor-lang-idl` honors `RUSTUP_TOOLCHAIN` (build.rs:64). Fallback if
  it fails: `nightly-2024-05-09`. **Cargo.lock stays as committed**
  (proc-macro2 1.0.93) — the BPF `.so` build (cargo build-sbf, stable
  1.79) is unaffected; this is host-only. Earlier proc-macro2 downgrade
  *and* upgrade experiments were abandoned; lockfile restored to the
  committed state.
- **CI:** set `RUSTUP_TOOLCHAIN=nightly-2025-03-01` (and
  `rustup toolchain install nightly-2025-03-01 --profile minimal`) for any
  job that runs `anchor build` / `anchor idl build`. Encoded as a
  workflow-level env var in `.github/workflows/build.yml` (created
  2026-10-08; the upstream fork had no CI).

## 2026-10-08 — Program ID: generated keypair, declare_id synced

- `declare_id!`/`Anchor.toml` carried the upstream placeholder
  `3UzMu6EhgnZMg95WpyDLA6JJPho2YEW7QF3sNcv4Zi8K`, for which no keypair
  existed anywhere; `target/deploy/rewards_distributor-keypair.json` held
  an unrelated key (`7zLE4T3hHQtAsd6YbxVzwtru4HCHzRGEKqpbvJpubYHg`,
  never deployed). Per the open item below ("after `anchor keys sync`"),
  resolved by **generating a fresh program keypair** and syncing the ID.
- **Program ID (devnet + mainnet):**
  `5cDhgYUjVdfXyYEYVfuyZBveR7fLBnNRRZ3aHHSKSRjg`, from
  `solana-keygen new -o target/deploy/rewards_distributor-keypair.json`.
  `declare_id!` (lib.rs:20) and `Anchor.toml` updated; `anchor keys list`,
  IDL `address`, and the keypair pubkey all agree.
- Keypair handling (operator constraints): file mode 0600, under
  `target/` (git-ignored, never committed); never in env vars, logs, or
  the DB; needed only for the first deployment. Pre-regeneration keypair
  backed up to `~/.podminer-offline-backup/rewards_distributor-keypair.v1.7zLE4.json`;
  the live program keypair gets an offline backup immediately after
  first deploy.
- First full `RUSTUP_TOOLCHAIN=nightly-2025-03-01 anchor build` after
  the sync: exit 0, .so SHA-256
  `486e3d249abeb989242ee6af6c06e29468c7fecf5404e1d39aa9e32f947ceda5`
  (includes the POD Miner `security_txt`). Re-record the hash after the
  final pre-deploy build — any source change changes it.

## 2026-10-08 — Bugs found by the devnet rehearsal (both fixed)

- **web3.js ≥1.87 signature encoding (`publish.ts`):** `tx.sign()` populates
  `tx.signature` with the raw 64 bytes; the code then base64-encoded them and
  every RPC call failed with "signature must be base58 encoded". Fix:
  `bs58.encode(tx.signature!)` (bs58 was already a dependency).
- **ClaimedRewards `claimed` offset (`publish.ts` `parseClaimedAmount`):** the
  parser read the u64 LE at offset 16, so API and reconcile always saw claimed
  = 0. True layout, verified against `state/claimed_rewards.rs` and a live
  account's raw hex (`69f69879f9638bd8 | 00 | 3b010000…` = 315): 8-byte
  discriminator, bump u8 @8, claimed u64 LE **@9**, padding to 32. API and
  reconcile share this one definition, so both were fixed by the same edit.

## 2026-10-08 — Program ID supersession (6S7a is final, both networks)

- The final program ID for devnet rehearsal AND mainnet is
  `6S7aGNpCdT8ADoVXUwQXJqVg63GRx9uteHDAycngyQcK` (keypair
  `target/deploy/rewards_distributor-keypair.json`, 0600, git-ignored;
  offline backup
  `~/.podminer-offline-backup/rewards_distributor-keypair.v3.6S7a.json`).
  Rationale: rehearsing on the exact bytecode and ID that ships avoids any
  post-rehearsal code churn — the only difference between devnet and mainnet
  is the cluster and the USDC mint.
- The earlier draft ID `5cDhgYUjVdfXyYEYVfuyZBveR7fLBnNRRZ3aHHSKSRjg` was
  closed on devnet (`solana program close --bypass-warning`, 1.92786508 SOL
  rent reclaimed); its keypair is retained offline as `.v2.5cDhg.json` for
  provenance only.
- Post-supersession build: .so SHA-256
  `238fe81fb12e2716d271d121c657830464561a7e25ffeb93914728c906e64084`
  (IDL address, `declare_id!`, `Anchor.toml` all agree on 6S7a).
- Devnet state after re-initialize: config PDA
  `BXUnNpGB9yaeU1TdWRC8nvsdj6xUMNxrXPG4jByKrSrT`, vault ATA
  `EopCTf6fqWPSMyxKKo3AidPHLfoQjqfr18XygzDJ5pse`, initialize sig
  `38rpGTizzZdYWauGJ9KKN76xFiSyPADpJLL6dYmBNzPqm9NMncSFL6XZRMTK1s4HQrgRSjrfHJ3vBWLLCr7XMifg`.

## 2026-10-08 — Rehearsal fixture generator (scripts/gen-rehearsal-fixture.mjs)

- Round dates MUST be strictly earlier than the current UTC date (rule 2
  rejects `round >= today`), so the generator defaults to "14 rounds ending
  yesterday" rather than a hard-coded future span. First draft hard-coded
  2026-10-08..2026-10-20 — every round would have been rejected.
- All 54 wallet keypairs are persisted to `scripts/rehearsal-claimants.json`
  (0600, git-ignored). First draft wrote only pubkeys, which made claims —
  the whole point of the rehearsal — impossible.
- Both files (`rehearsal-claimants.json`, `rehearsal-wallets.txt`) and
  `inbox/` are git-ignored: rehearsal material is devnet throwaway, not
  source.

## Open items (recorded as they are resolved)

- Public fork URL — after `gh repo create` (also correct
  `security_txt.source_code` in lib.rs if the URL differs from the
  recorded guess `https://github.com/fraserbrownirl/usdc-rewards-distributor`).
- Devnet rehearsal transcript — appended to `RUNBOOK.md` after the
  14-round rehearsal.
