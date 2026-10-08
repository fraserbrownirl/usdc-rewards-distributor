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
- 11:04 UTC — scheduler tick 2 published the 8-round backlog (one atomic
  fund+update_root tx per round, in order):
  - 2026-09-24 (3 wallets, 6) root c6231a241aac… sig
    `mtRgnw3eK9mbE5eZbb8LNm3b2PrkSe6goNk1qjg7Uk5mHoHu59WCfkEHaDTWj4XeAqZQd8B2qfNQQZjErY4Nu1d`
  - 2026-09-25 (3 wallets, 12) root 8af172347599… sig
    `2Rq6fjgUDu5tdMukx7N7XBYu32AG8cmWqxT8SACqYjNQkf1TeAk9kDCwCV8x2KFGxLJPihpMC5JshsPRMSSwL897`
  - 2026-09-26 (54 wallets, 1446) root d6a7819b1990… sig
    `3WNML3QGdsVH6zwFpYfUCaMJKs52qRZxr56DdW5LKEEMBgtGQcjSSmgyac2vPVLsxXZshTdJQa3MLoGPFFgrtBtk`
  - 2026-09-27 (3 wallets, 24) root a52eb799ea8a… sig
    `4914fbPZy8iZWH4jDCdy2zymuqJCApnaSkqcTD3c9QQzwWqi1brxxNYmjViNh9TYKMbqAX1PTMjCnZPyhMJvfRSX`
  - 2026-09-28 (3 wallets, 30) root 3b114b05a628… sig
    `56XLzN56TyprNzxGxSqz9mJQ1xkb3nsYufBpdSNufEiG77dtrbSE5MsvgvNkTanMTqZf9KJ9CECjCuJwcXF6rdKm`
  - 2026-09-29 (3 wallets, 36) root a677c2b9b671… sig
    `5zPv2ciWgQT6PxgwbUY4oyWZqEdzdUzYMtvi4xhzhgQjbM5AkveUTnvqGy4rZqYVWS731RGf6h7c4DeniN1tsQmP`
  - 2026-09-30 (3 wallets, 42) root 1c0ea475a329… sig
    `3uasDuvYgTDcSpC6G5K55suKow6jwobkH5gedqWcW2YhWXhd77iWPyGYLZDVMA46hLUkPQEFAuX23r1nX2PJ8ihG`
  - 2026-10-01 (3 wallets, 48) root aa5158e9df8d… sig
    `4DSQ31bwA3ovpqEWen29qnjXPugvCJYnLRSycZzVY6Gs23X5Loa2BFgG2oE3sgiWNuNhf5T4TRi6pAcX2D8E2xQx`
  - `reconcile: ok (vault=1644 claimed=0 funded=1644 records=0)`
- 11:08 UTC — daily claimer (claimants[0] E3NdU5Vf…) claimed 36 raw (6/day
  × 6 published days), cumulative-total proof verified on-chain, sig
  `gYMHyotHceeG7it59dXt7V2F9hBqV9AU9ZmUp4UjGvrioiNh7FXUGZc2cnZHVsV9QHS8isR69WSWFoRFgqAZpvZ`
  (retried=false).
- 11:04 UTC — deadline alerter fired `file_missing` for 2026-10-07 (held
  back deliberately; warning deduped against `.alert-state.json`).
- 11:19 UTC — day 9 (2026-10-02, missing-funding day) released with operator
  drained to 53 raw: ingested, tree root dd23608f7d10…, then
  `funding_missing` (operator USDC 53 < round total 54) — round left
  `ingested`, exit 0. Operator re-funded to 107 (mint 54 raw, sig
  `2nj3NyUQFvGsHdMa85GHomaKn9tyEH319edeKG6M5cZM7uxzan7fhnKWvP4qqi3AAYA2Sav31T9dQKiET7bsSS8Z`).
- 11:34 UTC — next tick published 2026-10-02, sig
  `32Tjqhi4Z374iLyHNMczyYphfK3mW23tpL7pfib1WgK7hnLAV32GRDuFENh91KjxMjx2o4U8mJhBoehncaM5z9ir`.
  `reconcile: ok (vault=1662 claimed=36 funded=1698 records=1)`.
- 11:35 UTC — daily claimer claimed 9 raw (total 45), sig
  `2A9Mg5kZivXsmieELNTkAbEWycTY8sKAwc9SzcPJZX1vNVFkisC4ACTwg1EKbGJ6FqwogahqGeUiK73uQ3bkrrj7`.
- 11:36 UTC — operator topped up to 353 raw (mint 300, sig
  `3e3noPn7hoSnietK69MAnYNDNq3uoQMWh6GLkm49UFg7AtHbGWrQpfJeRZ92wpnmMWbcTKTJARjXLMEW7LUvuzJQ`)
  and days 10–14 released from hold.
- 11:49 UTC — single tick swept the remaining five rounds:
  - 2026-10-03 (3 wallets, 60) root 160369241f6b… sig
    `2RWWCY7ioXqzzuaopKssneP5NNB2UhfBvbEjvRb3LicriRs4wCZntcBtZvCLrALe1RFAkQTMMHgwkAg4kthNLP2o`
  - 2026-10-04 (3 wallets, 66) root 8310479d578e… sig
    `vQRHbhYjWXqxAFh333y7zxEw7ZQiK5mDDJUyE4xQmXMTPQfGKFJBwTKUajJoeUXLWUNqYfipARCWi4a6JMVJJXj`
  - 2026-10-05 (3 wallets, 72) root b545568004a2… sig
    `4BK8EaWwTMdbpoTTTqa7KJHaWv2Xa4rv7fTzxVEHAtZZ3BxEcm73tcUUbjdDLirYs6sCNydk9P4SjqFW8aBt8e3V`
  - 2026-10-06 — **empty day**: `ingest: empty 2026-10-06`, marked `empty`,
    no publish tx (root unchanged). Empty-day semantics verified.
  - 2026-10-07 (3 wallets, 84) root 3602200a7cac… sig
    `4mCGhxQJSUKfaKwYhjzsxrDmArZ4K7ze9e76BNceE2G9QgiqUDWZtgKZyBi6K9x82vBJyJyBDagBJrUmMP1JYp1C`
  - `reconcile: ok (vault=1935 claimed=45 funded=1980 records=1)`
- 11:50 UTC — end claimer (claimants[1] 2hoqNVYk…) claimed 210 raw
  (2×(1+…+8,10,…,14) minus day-9/13), sig
  `BrtST4xqJx4N2BdnEMTzszmVG9ASrpbxDX2w63tKWMQMh6kixKv8miNS7tCek3ENvLfFvMn7LaJWtNcnmGooiwY`.
- 11:50 UTC — no-ATA wallet (claimants[2] HmFXSazQ…) claimed 276 raw; the
  claim transaction created its USDC ATA idempotently (verified: account
  exists post-claim, balance 0.000276), sig
  `4oeN6y1DuUs8fWUz6YTceJTR3maU6D8xWRswXC2nfp2BKzHr82cPGWpLa9wEmoM1nM3QEDvsWS5gj4pswG5RzEm`.
- 11:50 UTC — unknown wallet (all-ones) via API: total 0, claimed 0,
  claimable 0, empty proof, current root. `/v1/status`: round 2026-10-07,
  wallet_count 54, shutdown false.
- 11:51 UTC — final standalone reconcile: `{"ok":true,"vaultBalance":"1475",
  "claimedSum":"505","fundedTotal":"1980","claimRecords":3,
  "vaultUnstable":false,"overclaims":[]}`. Rehearsal complete: 14 rounds
  (13 published + 1 empty), 54 wallets, funding_missing ×2 verified,
  empty day verified, daily + end + no-ATA claimers verified, clean reconcile.
<!-- TRANSCRIPT-END -->

## 7. Mainnet deployment record

<!-- filled during the §13 launch -->
- Deploy signature: _pending_
- Initialize signature: _pending_
- Config PDA: _pending_
- Vault ATA: _pending_
- Canary rounds 1–3 (dates, sigs, reconcile results): _pending_
