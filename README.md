# POD Miner USDC Rewards Distributor

Daily USDC rebates for [POD Miner](https://www.pod-miner.com/app) API users,
paid out on Solana by a pull-based Merkle-distributor program. Each day the
operator publishes one new Merkle root covering every wallet's **cumulative
lifetime total**; users claim the difference between their total and what they
have already claimed, whenever they like, paying their own claim costs.

This repository is a fork of
[eq-lab/solana-rewards-distributor](https://github.com/eq-lab/solana-rewards-distributor)
at commit `58505855a86dc77d215f96027a5c6e66699a1cc8`, extended with the
off-chain pipeline (daily job, ledger, API, claim SDK) that operates the
program in production.

## Attribution and license

The on-chain program under `programs/` is a **minimal, intentional diff** on
top of the upstream EQ Lab project:

- the program ID (`declare_id!` / `Anchor.toml`), and
- the `security_txt!` metadata block (POD Miner contacts and this repository).

No instruction logic, account layout, or error code was changed. The upstream
project is licensed under the
[GNU General Public License v3](LICENSE); this fork remains under GPL-3.0, the
`LICENSE` file is unmodified, and upstream copyright and history are preserved
in the git history of this repository. Everything in this repository —
program and off-chain code alike — is GPL-3.0.

## What lives here

| Path | What it is |
| --- | --- |
| `programs/rewards-distributor` | The Anchor program (upstream fork, diff above) |
| `packages/distributor` | The daily job: ingest → Merkle tree → atomic fund+publish → reconcile |
| `packages/api` | Read-only REST API (rewards, proofs, history, status) |
| `packages/claim-sdk` | TypeScript SDK for building/sending claim transactions |
| `packages/merkle` | Merkle tree construction (double-SHA256 leaves, sorted pairs) |
| `packages/cli`, `packages/programs-wrappers` | Operator CLI + program bindings |
| `migrations/` | Postgres ledger schema |
| `ops/` | Docker stack: db + migrate + api + scheduler (cron `distributor run`) |
| `tests/` | On-chain program tests |

## How it works

1. A producer drops `INBOX_DIR/<YYYY-MM-DD>.json` (one round per UTC day:
   `{version, round, total, count, rewards}`) into the inbox, atomically.
2. The scheduler runs the job every 15 minutes. It validates the file
   (all-or-nothing), ingests it into the Postgres ledger, and folds the day's
   amounts into **lifetime totals** (totals never decrease).
3. The job builds a Merkle tree over all totals, then publishes **one atomic
   transaction**: `TransferChecked(round total)` operator → vault, plus
   `update_root(new_root)`.
4. Users fetch their total + proof from the API and claim with the SDK. The
   program transfers `total − already_claimed` from the vault to the user's
   USDC account.
5. After each run the job reconciles: `vault balance + Σ claimed ≥ Σ funded
   round totals`, and no claim record may exceed its wallet's total.

Round file format, invariants, alerts, and every unspecified detail of the
build are recorded in [DECISIONS.md](DECISIONS.md). Operating procedures —
deploy, initialize, launch, daily operation — are in [RUNBOOK.md](RUNBOOK.md).

## Development

Requirements: Rust 1.79.0 (via `rust-toolchain.toml`), Solana CLI 1.18.26,
Anchor CLI 0.30.1 (avm), Node 20, Yarn 1.22.22, Postgres 15 (Docker).

The IDL build needs a pinned nightly (see DECISIONS.md — `anchor-lang-idl`
honors `RUSTUP_TOOLCHAIN`):

```bash
yarn
RUSTUP_TOOLCHAIN=nightly-2025-03-01 anchor build
yarn workspaces run test
```

CI (`.github/workflows/build.yml`) builds the program and runs the unit
tests on every push with the same pinned toolchain.

## Deployment

Program ID (devnet rehearsal + mainnet):
[`6S7aGNpCdT8ADoVXUwQXJqVg63GRx9uteHDAycngyQcK`](https://solscan.io/account/6S7aGNpCdT8ADoVXUwQXJqVg63GRx9uteHDAycngyQcK)

Deploy and launch procedures, with the devnet rehearsal transcript, are in
[RUNBOOK.md](RUNBOOK.md). One operator key serves as upgrade authority,
admin, updater, and job signer (see DECISIONS.md for the key-handling rules).

---

*Upstream README for the program itself, including its instruction set and
development notes, is preserved in git history (`git show 5850585:README.md`).*
