# Operations Runbook — POD Miner USDC Rewards Distributor

This runbook covers: deployment (§13 of the build spec), initialization,
daily operation, incident handling, and the devnet rehearsal that preceded
mainnet launch. Program details and the "why" behind every rule live in
[DECISIONS.md](DECISIONS.md); this file is the "how".

Canonical identifiers (devnet rehearsal + mainnet — one program ID for both):

| Thing | Address |
| --- | --- |
| Program ID | `6S7aGNpCdT8ADoVXUwQXJqVg63GRx9uteHDAycngyQcK` |
| Config PDA (devnet) | `BXUnNpGB9yaeU1TdWRC8nvsdj6xUMNxrXPG4jByKrSrT` |
| Vault ATA (devnet) | `EopCTf6fqWPSMyxKKo3AidPHLfoQjqfr18XygzDJ5pse` |
| Devnet USDC mint | `4aa1VDp94MfisHLZpRpdgcLrQxTQknzP5bbLuo1uJhfT` |
| Mainnet USDC mint | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| Operator (all roles) | `FMMktQmbEQwc8yZnnTWxahy1QY7YhGzRDJnztprJwvZY` |

One operator key serves as upgrade authority, program admin, updater, and
job signer. It is a file (`0600`) on the job host: never committed, never in
an env var's value, never logged, never in the database, unreadable by the
API process. The program keypair is needed only for the first deployment and
lives offline afterwards (`~/.podminer-offline-backup/`).

## 1. Build and deploy

Toolchain: Rust 1.79.0 (rust-toolchain.toml), Solana CLI 1.18.26, Anchor
0.30.1, Node 20, Yarn 1.22.22. The IDL build needs the pinned nightly
(`anchor-lang-idl` honors `RUSTUP_TOOLCHAIN`):

```bash
yarn
RUSTUP_TOOLCHAIN=nightly-2025-03-01 anchor build
sha256sum target/deploy/rewards_distributor.so
```

Record the .so SHA-256 in DECISIONS.md. The rehearsal build's hash:
`238fe81fb12e2716d271d121c657830464561a7e25ffeb93914728c906e64084`.

Fund the operator with 2× program rent + 0.1 SOL, then deploy with the
operator as upgrade authority:

```bash
solana program deploy target/deploy/rewards_distributor.so \
  --url <cluster> --keypair ~/.config/solana/id.json \
  --upgrade-authority ~/.config/solana/id.json \
  --program-id target/deploy/rewards_distributor-keypair.json
```

The program keypair goes offline immediately after first deploy.

## 2. Initialize

Creates the config PDA and its ATA vault in one transaction. The
`--private-key-file` flag is required (the operator key never rides in an
env var):

```bash
CLUSTER=<devnet|mainnet> RPC_URL=<rpc> \
PROGRAM_ID=6S7aGNpCdT8ADoVXUwQXJqVg63GRx9uteHDAycngyQcK \
USDC_MINT=<mint> \
node packages/distributor/dist/cli.js admin initialize \
  --private-key-file ~/.config/solana/id.json
```

Verify:

```bash
... node packages/distributor/dist/cli.js status
# expect: admin = operator, updater = operator, root = zero (uninitialized)
```

Create the operator's USDC ATA and fund it with the first rounds' budget.
Record config PDA, vault ATA, and the initialize signature in this file
(mainnet section below).

## 3. Daily operation (ops/ Docker stack)

`ops/docker-compose.yml` runs four services: `db` (Postgres 15), `migrate`
(one-shot), `api` (read-only REST, :8080), `scheduler` (cron: `distributor
run` every 15 min). Configuration is via `ops/.env` — see the compose file;
the operator key is mounted as a file for the scheduler only.

The producer drops `INBOX_DIR/<YYYY-MM-DD>.json` atomically (tmp + rename).
The 15-minute `run`:

1. validates every new file all-or-nothing (a rejected file blocks all
   later rounds until a human fixes it — by design);
2. ingests valid rounds into the ledger, folding amounts into lifetime
   totals (a DB trigger rejects any decrease);
3. builds the Merkle tree over all totals;
4. if operator USDC < round total: fires the `funding_missing` alert and
   stops (round stays `ingested`; the next tick retries — top up the
   operator and wait);
5. publishes ONE atomic transaction: TransferChecked(round total) operator
   → vault + update_root(new root);
6. reconciles: vault + Σ claimed ≥ Σ funded, no claim above its total.

Manual equivalents (same env as the compose `scheduler` service):

```bash
node packages/distributor/dist/cli.js run          # one pass
node packages/distributor/dist/cli.js reconcile    # solvency check only
node packages/distributor/dist/cli.js status       # on-chain + DB summary
node packages/distributor/dist/cli.js export-outstanding  # owed per wallet
```

## 4. Incident handling

- **`funding_missing`** (error alert): operator USDC balance < next round
  total. Top up the operator ATA; the next scheduler tick publishes the
  backlog automatically. Nothing is stuck.
- **`rejected file`**: the file fails validation (bad schema, total/count
  mismatch, duplicate wallet, round not earlier than today, or round not
  after the latest ingested round). All later files wait. Fix or remove the
  file (see `inbox/rejected/`), then let the next tick proceed.
- **`root_mismatch` / `solvency` / `overclaim`** (critical alerts): the
  publish pipeline stops. Investigate before restarting — these mean
  on-chain state and the ledger disagree.
- **Low operator SOL** (< `MIN_OPERATOR_SOL_LAMPORTS`): warning alert; the
  job pays tx fees and claim-record rent refunds come back to the operator.
  Top up SOL.

## 5. Mainnet launch (spec §13) + canary

1. `RUSTUP_TOOLCHAIN=nightly-2025-03-01 anchor build` — confirm the .so hash
   equals the rehearsal build (`238fe81f…` above); if not, STOP and diff.
2. Fund operator: 2× program rent + 0.1 SOL; deploy (§1) with operator as
   upgrade authority; program keypair offline.
3. `admin initialize` against mainnet USDC; record config/vault/sig in §7.
4. Create operator mainnet USDC ATA; fund with canary budget only.
5. Bring up the ops stack (§3) with mainnet env.
6. **Canary: 3 rounds, 2–3 internal wallets, ≤10 USDC total.** Each round:
   drop the file, watch one tick publish it, claim with the SDK from the
   canary wallet, `distributor reconcile` clean. Only after 3 clean canary
   rounds: announce the API to users.
7. Record every address and signature in §7 as it happens.

## 6. Devnet rehearsal transcript (spec §12)

Program deployed to devnet at the ID above (supersedes the discarded draft
`5cDhgYUjVdfXyYEYVfuyZBveR7fLBnNRRZ3aHHSKSRjg`, closed on devnet,
1.92786508 SOL reclaimed). Initialize sig
`38rpGTizzZdYWauGJ9KKN76xFiSyPADpJLL6dYmBNzPqm9NMncSFL6XZRMTK1s4HQrgRSjrfHJ3vBWLLCr7XMifg`.

Fixture: `scripts/gen-rehearsal-fixture.mjs` — 14 rounds 2026-09-24 →
2026-10-07, 54 wallets (daily claimer [0] `E3NdU5VfozjxnJRABSp5AbP9hbfi6rfVViNDkaDtq4bd`,
end claimer [1] `2hoqNVYkeLnQnBjB8aXJeD4Wbg3oqkJyvL6k9E2AbXzJ`,
no-ATA [2] `HmFXSazQ1LoM55kuU43TbqfBFJV3etkoEwtWnvVmMdQR`, 51 background
on day 3 only). Day 9 (2026-10-02) is the missing-funding day; day 13
(2026-10-06) is the empty day. All keypairs in
`scripts/rehearsal-claimants.json` (0600, git-ignored).

<!-- TRANSCRIPT-START — filled as the rehearsal completes -->
- 10:49 UTC — scheduler tick 1: ingested 2026-09-24 (3 wallets, total 6),
  tree root c6231a241aac…, then `funding_missing` (operator USDC 0 < 6) —
  round left `ingested`, days 2–8 untouched. Pause semantics verified.
- 10:55 UTC — operator re-funded: minted 3,000 USDC, sig
  `3wcgBtQFrTLKeQqLu4RaE184emekeQCLVU53RdjhvdLa89rTWpsWD59gxVvc8R7izYbsBMqhTn2XKrAsjetrVhkL`.
<!-- TRANSCRIPT-END -->

## 7. Mainnet deployment record

<!-- filled during the §13 launch -->
- Deploy signature: _pending_
- Initialize signature: _pending_
- Config PDA: _pending_
- Vault ATA: _pending_
- Canary rounds 1–3 (dates, sigs, reconcile results): _pending_
