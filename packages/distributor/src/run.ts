import { readFileSync } from 'fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PoolClient } from 'pg';
import { buildTree, proofToBytes } from '@podminer/merkle';
import { Db } from './db';
import { JobConfig } from './config';
import { Alerter } from './alerts';
import { ingestEarliest } from './ingest';
import { reconcile, ReconcileReport } from './reconcile';
import { deadlineAlerts } from './deadlines';
import {
    deriveVault,
    fetchOnChainConfig,
    OnChainConfig,
    publishRound,
    PublishOutcome,
    ZERO_ROOT_HEX,
} from './publish';

/**
 * The daily job — spec §8, twelve steps in order:
 *   1. advisory lock (held by the caller's withAdvisoryLock)
 *   2. preflight: on-chain config matches expectation + DB invariants 1 & 2
 *   3. root sanity: on-chain root is zero or a tree we have
 *   4. resume an ingested (unpublished) round at step 6
 *   5. ingest the earliest inbox file (empty days record status 'empty' and
 *      loop; no file moves to step 11)
 *   6. build the Merkle tree from every totals row, store tree + proofs
 *   7. on-chain root already equals the new root -> step 10
 *   8. funding: operator USDC >= round total, SOL >= MIN_OPERATOR_SOL_LAMPORTS
 *   9. one atomic tx: TransferChecked(round total) + update_root(new root),
 *      signature stored before sending; expired-unconfirmed -> back to 7
 *  10. mark the round published, prune trees, return to step 5
 *  11. reconcile (on-chain vault/claims vs funded totals)
 *  12. deadline alerts (file_missing 02:00 UTC, publish_overdue 06:00 UTC)
 *
 * Any critical alert throws `CriticalStop` (step 12 excepted): the CLI maps
 * it to a non-zero exit and the job stays stopped until a person intervenes.
 * Steps 11–12 are best-effort: their failures are logged and alerted but do
 * not undo a successful publish.
 */

export class CriticalStop extends Error {
    constructor(
        public readonly alertName: string,
        message: string
    ) {
        super(message);
        this.name = 'CriticalStop';
    }
}

export function loadOperatorKeypair(path: string): Keypair {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return Keypair.fromSecretKey(Uint8Array.from(raw));
}

const MAX_PUBLISH_ATTEMPTS = 5;

/** Step 2: on-chain config must match what the job expects. */
function checkConfigDrift(cfg: JobConfig, operator: Keypair, onchain: OnChainConfig): string[] {
    const drift: string[] = [];
    const mint = new PublicKey(cfg.usdcMint);
    const programId = new PublicKey(cfg.programId);
    if (!onchain.admin.equals(operator.publicKey)) {
        drift.push(`admin ${onchain.admin} != operator ${operator.publicKey}`);
    }
    if (!onchain.updater.equals(operator.publicKey)) {
        drift.push(`updater ${onchain.updater} != operator ${operator.publicKey}`);
    }
    if (!onchain.mint.equals(mint)) {
        drift.push(`mint ${onchain.mint} != USDC_MINT ${mint}`);
    }
    const vault = deriveVault(mint, programId);
    if (!onchain.vault.equals(vault)) {
        drift.push(`token_vault ${onchain.vault} != derived ${vault}`);
    }
    if (onchain.shutdown) drift.push('shutdown flag is set');
    return drift;
}

async function critical(alerter: Alerter, name: string, detail: string, context?: Record<string, unknown>): Promise<never> {
    await alerter.critical(name, detail, context);
    throw new CriticalStop(name, detail);
}

/** Standalone reconcile with the same on-chain config preflight as the job. */
export async function reconcileCommand(db: Db, cfg: JobConfig, alerter: Alerter): Promise<{ ok: boolean; report: ReconcileReport }> {
    const client = await db.pool.connect();
    try {
        const connection = new Connection(cfg.rpcUrl, 'confirmed');
        const onchain = await fetchOnChainConfig(connection, new PublicKey(cfg.programId));
        const operator = loadOperatorKeypair(cfg.operatorKeypairPath);
        const drift = checkConfigDrift(cfg, operator, onchain);
        if (drift.length > 0) {
            await critical(alerter, 'config_drift', `on-chain config drift: ${drift.join('; ')}`, { drift });
        }
        const report = await reconcile(db, cfg, alerter, client);
        return { ok: report.ok, report };
    } finally {
        client.release();
    }
}

/** Steps 6–10 for the pending ingested round. */
async function publishPending(
    db: Db,
    cfg: JobConfig,
    operator: Keypair,
    alerter: Alerter,
    client: PoolClient,
    connection: Connection,
    onchainRoot: Buffer
): Promise<{ published: boolean; exit: 'none' | 'funding' | 'failed' }> {
    const pending = await db.pendingIngestedRound(client);
    if (!pending) return { published: false, exit: 'none' };
    const round = pending.round;
    const roundTotal = BigInt(pending.total);
    const programId = new PublicKey(cfg.programId);
    const mint = new PublicKey(cfg.usdcMint);

    // Step 6: tree from every row of totals; skip the insert if we have it.
    const totals = await db.allTotals(client);
    const tree = buildTree(
        [...totals.entries()].map(([wallet, total]) => ({ wallet: new PublicKey(wallet).toBuffer(), total }))
    );
    const newRoot = tree.root;
    const newRootHex = newRoot.toString('hex');
    const totalSum = [...totals.values()].reduce((a, b) => a + b, 0n);
    const proofs = new Map<string, { total: bigint; proof: Buffer }>();
    for (const e of tree.entries) {
        const proof = tree.proofs.get(e.wallet.toString('hex'))!;
        proofs.set(new PublicKey(e.wallet).toBase58(), { total: e.total, proof: proofToBytes(proof) });
    }
    const stored = await db.storeTree(client, newRootHex, round, tree.entries.length, totalSum, proofs);
    console.log(`tree: root=${newRootHex.slice(0, 12)}… wallets=${tree.entries.length} total=${totalSum}${stored ? '' : ' (already stored)'}`);

    // Step 7: maybe the root already landed (earlier attempt or identical totals).
    if (!onchainRoot.equals(newRoot)) {
        // Step 8: funding checks. Missing funds pause the job for this run
        // (exit 0) — the next scheduler tick retries.
        const operatorAta = getAssociatedTokenAddressSync(mint, operator.publicKey);
        const usdc = await connection
            .getTokenAccountBalance(operatorAta, 'confirmed')
            .then((b) => BigInt(b.value.amount))
            .catch(() => 0n);
        if (usdc < roundTotal) {
            await alerter.error('funding_missing', `operator USDC ${usdc} < round total ${roundTotal}`, {
                round,
                operatorUsdc: usdc.toString(),
                roundTotal: roundTotal.toString(),
            });
            return { published: false, exit: 'funding' };
        }
        const sol = BigInt(await connection.getBalance(operator.publicKey, 'confirmed'));
        if (sol < BigInt(cfg.minOperatorSolLamports)) {
            await alerter.warning('operator_sol_low', `operator SOL ${sol} < ${cfg.minOperatorSolLamports}`, {
                round,
                operatorSol: sol.toString(),
            });
            return { published: false, exit: 'funding' };
        }

        // Step 9: fund + update_root atomically; expired-unconfirmed retries.
        let outcome: PublishOutcome | null = null;
        for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt++) {
            const o = await publishRound(db, cfg, operator, alerter, client, round, roundTotal, newRoot, newRootHex);
            if (o.outcome === 'confirmed') {
                outcome = o;
                break;
            }
            // Blockhash expired unconfirmed: re-check whether it landed anyway.
            const again = await fetchOnChainConfig(connection, programId).catch(() => null);
            if (again && newRoot.equals(Buffer.from(again.root))) {
                const st = await connection.getSignatureStatus(o.signature).catch(() => null);
                outcome = { outcome: 'confirmed', signature: o.signature, lastValidBlockHeight: o.lastValidBlockHeight, slot: st?.value?.slot ?? 0 };
                break;
            }
        }
        if (!outcome) {
            await alerter.error('publish_failed', `publish for round ${round} did not land after ${MAX_PUBLISH_ATTEMPTS} attempts`, { round });
            return { published: false, exit: 'failed' };
        }

        // Step 10: record the publish in its own transaction.
        await db.markPublished(client, round, newRootHex, outcome.signature, outcome.slot, outcome.lastValidBlockHeight);
        console.log(`published: round=${round} root=${newRootHex.slice(0, 12)}… sig=${outcome.signature}`);
    } else {
        await db.markPublished(client, round, newRootHex, pending.publish_signature ?? '', pending.publish_slot ?? 0, pending.publish_last_valid_block_height ?? 0);
        console.log(`published: round=${round} root=${newRootHex.slice(0, 12)}… (root already on-chain)`);
    }

    // Retention: keep the 2 newest trees, never delete the on-chain root's.
    const latest = await fetchOnChainConfig(connection, programId).catch(() => null);
    const liveRootHex = latest ? Buffer.from(latest.root).toString('hex') : newRootHex;
    const pruned = await db.pruneTrees(client, liveRootHex);
    if (pruned.length > 0) console.log(`pruned ${pruned.length} old tree(s)`);

    return { published: true, exit: 'none' };
}

/**
 * Steps 2–12. Assumes the advisory lock is already held on `client`.
 * Returns the process exit code (0 ok / funding pause, 1 failure).
 */
export async function runJob(db: Db, cfg: JobConfig, alerter: Alerter, client: PoolClient): Promise<number> {
    const operator = loadOperatorKeypair(cfg.operatorKeypairPath);
    const connection = new Connection(cfg.rpcUrl, 'confirmed');
    const programId = new PublicKey(cfg.programId);

    // Step 2: preflight.
    const onchain = await fetchOnChainConfig(connection, programId);
    const drift = checkConfigDrift(cfg, operator, onchain);
    if (drift.length > 0) {
        await critical(alerter, 'config_drift', `on-chain config drift: ${drift.join('; ')}`, { drift });
    }
    for (const v of await db.checkInvariant1(client)) {
        await critical(alerter, 'invariant_failed', `invariant 1: ${v}`);
    }
    // Invariant 2 only bites in steady state: with a round awaiting publish,
    // totals legitimately lead the newest tree (e.g. a previous run stopped
    // between ingest and storeTree — resume, don't halt).
    if (!(await db.pendingIngestedRound(client))) {
        for (const v of await db.checkInvariant2(client)) {
            await critical(alerter, 'invariant_failed', `invariant 2: ${v}`);
        }
    }

    // Step 3: root sanity.
    const onChainRootHex = Buffer.from(onchain.root).toString('hex');
    if (onChainRootHex !== ZERO_ROOT_HEX && !(await db.treeExists(client, onChainRootHex))) {
        await critical(alerter, 'root_mismatch', `on-chain root ${onChainRootHex} not in stored trees`, {
            onChainRoot: onChainRootHex,
        });
    }

    // Steps 4/5/10 loop: resume or ingest, publish, repeat.
    for (;;) {
        if (!(await db.pendingIngestedRound(client))) {
            const ing = await ingestEarliest(db, cfg.inboxDir, client);
            if (ing.action === 'rejected') {
                await alerter.error('file_rejected', `round file rejected: ${ing.detail}`, { round: ing.round });
            }
            if (ing.action === 'none' || ing.action === 'rejected') break;
            if (ing.action === 'empty' || ing.action === 'noop') {
                console.log(`ingest: ${ing.action}${ing.round ? ` ${ing.round}` : ''}`);
                continue; // step 5 again
            }
            console.log(`ingest: ingested ${ing.round} (${ing.detail})`);
        }
        const r = await publishPending(db, cfg, operator, alerter, client, connection, Buffer.from(onchain.root));
        if (r.exit === 'funding' || r.exit === 'failed') return 0; // funding pause: exit 0, next tick retries
        // published: step 10 returns to step 5
    }

    // Step 11: reconcile (best-effort — a failed reconcile does not undo
    // today's publish; alerts already fired inside).
    try {
        const report = await reconcile(db, cfg, alerter, client);
        console.log(
            `reconcile: ${report.ok ? 'ok' : 'VIOLATIONS'} (vault=${report.vaultBalance} claimed=${report.claimedSum} funded=${report.fundedTotal} records=${report.claimRecords})`
        );
    } catch (e) {
        console.error(`reconcile error: ${(e as Error).message}`);
        await alerter.error('publish_failed', `reconcile crashed: ${(e as Error).message}`, {});
    }

    // Step 12: deadline alerts (fails are non-fatal).
    try {
        await deadlineAlerts(db, cfg, alerter);
    } catch (e) {
        console.error(`deadline checks error: ${(e as Error).message}`);
    }

    return 0;
}
