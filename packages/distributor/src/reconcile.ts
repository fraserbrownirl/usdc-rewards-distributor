import { Connection, PublicKey } from '@solana/web3.js';
import { Db } from './db';
import { Config } from './config';
import { fetchOnChainRoot } from './publish';
import { PoolClient } from 'pg';

/**
 * Reconciliation — spec §12. Runs after every publish and on demand.
 *   I1: sum(round_rewards) per round == rounds.total
 *   I2: newest tree's implied totals == totals table
 *   I3: vault balance + sum(claim_record) >= sum(funded published rounds)
 *   I4: DB newest published root == on-chain root
 * Returns the list of violations (empty = healthy).
 */

export interface ReconcileReport {
    ok: boolean;
    violations: string[];
    numbers: {
        funded: string;
        claimed: string;
        vault: string;
        onChainRoot: string;
        dbRoot: string | null;
    };
}

export async function reconcile(
    db: Db,
    cfg: Config,
    client: PoolClient
): Promise<ReconcileReport> {
    const violations: string[] = [];

    for (const v of await db.checkInvariant1(client)) violations.push(`I1 ${v}`);
    for (const v of await db.checkInvariant2(client)) violations.push(`I2 ${v}`);

    const { funded, claimed } = await db.reconciliationNumbers(client);

    const connection = new Connection(cfg.rpcUrl, 'confirmed');
    const onchain = await fetchOnChainRoot(connection, new PublicKey(cfg.programId));
    const vaultBal = await connection.getTokenAccountBalance(onchain.vault).catch(() => null);
    const vault = vaultBal ? BigInt(vaultBal.value.amount) : 0n;

    // I3: vault + claimed >= funded (claimed comes from totals.claim_record,
    // updated by the claim indexer; pre-indexer this is conservative).
    if (vault + claimed < funded) {
        violations.push(
            `I3 vault ${vault} + claimed ${claimed} = ${vault + claimed} < funded ${funded}`
        );
    }

    // I4: DB's newest published round root must equal the on-chain root.
    const { rows } = await client.query(
        `SELECT root FROM rounds WHERE status = 'published' ORDER BY round DESC LIMIT 1`
    );
    const dbRoot: string | null = rows[0]?.root ?? null;
    const onChainRoot = Buffer.from(onchain.root).toString('hex');
    const anyPublished = await client.query(`SELECT 1 FROM rounds WHERE status = 'published' LIMIT 1`);
    if (anyPublished.rows.length > 0 && dbRoot !== onChainRoot) {
        violations.push(`I4 db root ${dbRoot ?? 'none'} != on-chain root ${onChainRoot}`);
    }

    return {
        ok: violations.length === 0,
        violations,
        numbers: {
            funded: funded.toString(),
            claimed: claimed.toString(),
            vault: vault.toString(),
            onChainRoot,
            dbRoot,
        },
    };
}
