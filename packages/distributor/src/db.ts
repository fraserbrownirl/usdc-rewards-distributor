import { Pool, PoolClient } from 'pg';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { PublicKey } from '@solana/web3.js';

/**
 * Postgres access layer for the distributor ledger (spec §7).
 *
 * The ledger is the source of truth for rounds, lifetime totals and proofs.
 * `totals.claim_record` is the wallet's derived ClaimedRewards PDA address,
 * stored at first insert so the API and reconcile can read claims on-chain
 * without re-deriving.
 */

export const CLAIMED_SEED = 'ClaimedRewards';

export function claimRecordPda(programId: string | PublicKey, wallet: string): string {
    const pid = typeof programId === 'string' ? new PublicKey(programId) : programId;
    return PublicKey.findProgramAddressSync(
        [Buffer.from(CLAIMED_SEED), new PublicKey(wallet).toBuffer()],
        pid
    )[0].toBase58();
}

export type RoundStatus = 'ingested' | 'published' | 'empty';

export interface RoundRow {
    round: string; // YYYY-MM-DD
    file_sha256: string;
    total: string; // numeric as string
    wallet_count: number;
    status: RoundStatus;
    root: string | null;
    publish_signature: string | null;
    publish_slot: number | null;
    publish_last_valid_block_height: number | null;
}

export interface TreeRow {
    root: string;
    round: string;
    wallet_count: number;
    total_sum: string;
}

export interface ProofRow {
    total: string;
    proof: Buffer;
}

const ROUND_COLS = `round::text AS round, file_sha256, total::text AS total, wallet_count, status,
        root, publish_signature, publish_slot, publish_last_valid_block_height`;

export class Db {
    public readonly pool: Pool;

    constructor(
        databaseUrl: string,
        /** When set, claim_record addresses are derived with this program ID. */
        public readonly programId: string | null = null
    ) {
        this.pool = new Pool({ connectionString: databaseUrl, max: 4 });
    }

    async close(): Promise<void> {
        await this.pool.end();
    }

    private q(client: PoolClient | undefined) {
        return (client ?? this.pool).query.bind(client ?? this.pool);
    }

    /** Apply pending migrations from migrations/ (numbered .sql files). */
    async migrate(migrationsDir: string): Promise<number[]> {
        const applied: number[] = [];
        const client = await this.pool.connect();
        try {
            await client.query(
                'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())'
            );
            const files = readdirSync(migrationsDir)
                .filter((f) => /^\d+_.*\.sql$/.test(f))
                .sort();
            for (const f of files) {
                const version = parseInt(f.split('_')[0], 10);
                const { rows } = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [
                    version,
                ]);
                if (rows.length > 0) continue;
                const sql = readFileSync(join(migrationsDir, f), 'utf8');
                await client.query('BEGIN');
                try {
                    await client.query(sql);
                    await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
                    await client.query('COMMIT');
                    applied.push(version);
                } catch (e) {
                    await client.query('ROLLBACK');
                    throw e;
                }
            }
        } finally {
            client.release();
        }
        return applied;
    }

    /** Advisory lock for `distributor run` — one job at a time. */
    async withAdvisoryLock<T>(fn: (client: PoolClient) => Promise<T>): Promise<T | null> {
        const client = await this.pool.connect();
        try {
            const { rows } = await client.query('SELECT pg_try_advisory_lock(727272)');
            if (!rows[0].pg_try_advisory_lock) return null; // another run holds it
            try {
                return await fn(client);
            } finally {
                await client.query('SELECT pg_advisory_unlock(727272)');
            }
        } finally {
            client.release();
        }
    }

    async lastIngestedRound(client?: PoolClient): Promise<{ round: string; file_sha256: string } | null> {
        const { rows } = await this.q(client)(
            `SELECT round::text, file_sha256 FROM rounds ORDER BY round DESC LIMIT 1`
        );
        return rows[0] ?? null;
    }

    /** The one round awaiting publish, if any (partial unique index enforces <= 1). */
    async pendingIngestedRound(client?: PoolClient): Promise<RoundRow | null> {
        const { rows } = await this.q(client)(`SELECT ${ROUND_COLS} FROM rounds WHERE status = 'ingested' LIMIT 1`);
        return rows[0] ?? null;
    }

    /** Latest round by date in any of the given statuses. */
    async latestRound(client: PoolClient | undefined, statuses: RoundStatus[]): Promise<RoundRow | null> {
        const { rows } = await this.q(client)(
            `SELECT ${ROUND_COLS} FROM rounds WHERE status = ANY($1) ORDER BY round DESC LIMIT 1`,
            [statuses]
        );
        return rows[0] ?? null;
    }

    async allTotals(client?: PoolClient): Promise<Map<string, bigint>> {
        const { rows } = await this.q(client)(`SELECT wallet, total::text AS total FROM totals`);
        const m = new Map<string, bigint>();
        for (const r of rows) m.set(r.wallet, BigInt(r.total));
        return m;
    }

    /** Insert an ingested round + its rewards + bump totals, atomically. */
    async ingestRound(
        client: PoolClient,
        round: string,
        fileSha256: string,
        total: bigint,
        rewards: { wallet: string; amount: bigint }[]
    ): Promise<void> {
        if (!this.programId) throw new Error('Db constructed without programId cannot ingest');
        const programId = this.programId;
        await client.query('BEGIN');
        try {
            await client.query(
                `INSERT INTO rounds (round, file_sha256, total, wallet_count, status)
                 VALUES ($1, $2, $3, $4, 'ingested')`,
                [round, fileSha256, total.toString(), rewards.length]
            );
            for (const r of rewards) {
                await client.query(
                    `INSERT INTO round_rewards (round, wallet, amount) VALUES ($1, $2, $3)`,
                    [round, r.wallet, r.amount.toString()]
                );
                await client.query(
                    `INSERT INTO totals (wallet, total, updated_round, claim_record) VALUES ($1, $2, $3, $4)
                     ON CONFLICT (wallet) DO UPDATE SET total = totals.total + EXCLUDED.total,
                                                        updated_round = EXCLUDED.updated_round`,
                    [r.wallet, r.amount.toString(), round, claimRecordPda(programId, r.wallet)]
                );
            }
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        }
    }

    /** Record an empty round (no rewards that day). */
    async insertEmptyRound(client: PoolClient, round: string, fileSha256: string): Promise<void> {
        await client.query(
            `INSERT INTO rounds (round, file_sha256, total, wallet_count, status)
             VALUES ($1, $2, 0, 0, 'empty')`,
            [round, fileSha256]
        );
    }

    /**
     * Insert a tree + its proofs in one transaction (spec §8 step 6). If the
     * root already exists, skip the insert entirely. Returns false when the
     * tree was already stored.
     */
    async storeTree(
        client: PoolClient,
        root: string,
        round: string,
        walletCount: number,
        totalSum: bigint,
        proofs: Map<string, { total: bigint; proof: Buffer }>
    ): Promise<boolean> {
        await client.query('BEGIN');
        try {
            const { rowCount } = await client.query(
                `INSERT INTO trees (root, round, wallet_count, total_sum) VALUES ($1, $2, $3, $4)
                 ON CONFLICT (root) DO NOTHING`,
                [root, round, walletCount, totalSum.toString()]
            );
            if (rowCount === 0) {
                await client.query('COMMIT');
                return false;
            }
            for (const [wallet, p] of proofs) {
                await client.query(
                    `INSERT INTO proofs (root, wallet, total, proof) VALUES ($1, $2, $3, $4)
                     ON CONFLICT (root, wallet) DO NOTHING`,
                    [root, wallet, p.total.toString(), p.proof]
                );
            }
            await client.query('COMMIT');
            return true;
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        }
    }

    /** Store the publish signature + lastValidBlockHeight BEFORE the tx is sent. */
    async recordPublishAttempt(
        client: PoolClient,
        round: string,
        signature: string,
        lastValidBlockHeight: number
    ): Promise<void> {
        await client.query(
            `UPDATE rounds SET publish_signature = $2, publish_last_valid_block_height = $3 WHERE round = $1`,
            [round, signature, lastValidBlockHeight]
        );
    }

    /** Mark a round published (its own transaction: spec §8 step 10). */
    async markPublished(
        client: PoolClient,
        round: string,
        root: string,
        signature: string,
        slot: number,
        lastValidBlockHeight: number
    ): Promise<void> {
        await client.query('BEGIN');
        try {
            await client.query(
                `UPDATE rounds SET status = 'published', root = $2, publish_signature = $3,
                    publish_slot = $4, publish_last_valid_block_height = $5, published_at = now()
                 WHERE round = $1`,
                [round, root, signature, slot, lastValidBlockHeight]
            );
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        }
    }

    /** Retain the 2 newest trees; never delete the on-chain root's tree. */
    async pruneTrees(client: PoolClient, onChainRoot: string): Promise<string[]> {
        const { rows } = await client.query(
            `SELECT root FROM trees WHERE root <> $1 ORDER BY created_at DESC OFFSET 2`,
            [onChainRoot]
        );
        const pruned: string[] = [];
        for (const r of rows) {
            await client.query(`DELETE FROM trees WHERE root = $1`, [r.root]);
            pruned.push(r.root);
        }
        return pruned;
    }

    async treeExists(client: PoolClient | undefined, root: string): Promise<boolean> {
        const { rows } = await this.q(client)(`SELECT 1 FROM trees WHERE root = $1`, [root]);
        return rows.length > 0;
    }

    async getTree(client: PoolClient | undefined, root: string): Promise<TreeRow | null> {
        const { rows } = await this.q(client)(
            `SELECT root, round::text AS round, wallet_count, total_sum::text AS total_sum FROM trees WHERE root = $1`,
            [root]
        );
        return rows[0] ?? null;
    }

    async getProof(client: PoolClient | undefined, root: string, wallet: string): Promise<ProofRow | null> {
        const { rows } = await this.q(client)(
            `SELECT total::text AS total, proof FROM proofs WHERE root = $1 AND wallet = $2`,
            [root, wallet]
        );
        return rows[0] ?? null;
    }

    /** Map claim-record PDA addresses back to wallets via totals.claim_record. */
    async walletsByClaimRecords(
        client: PoolClient | undefined,
        addresses: string[]
    ): Promise<Map<string, { wallet: string; total: string }>> {
        if (addresses.length === 0) return new Map();
        const { rows } = await this.q(client)(
            `SELECT wallet, total::text AS total, claim_record FROM totals WHERE claim_record = ANY($1)`,
            [addresses]
        );
        const m = new Map<string, { wallet: string; total: string }>();
        for (const r of rows) m.set(r.claim_record, { wallet: r.wallet, total: r.total });
        return m;
    }

    /** Invariant 1: SUM(totals.total) == SUM(rounds.total) over ingested + published. */
    async checkInvariant1(client: PoolClient): Promise<string[]> {
        const { rows } = await client.query(
            `SELECT (SELECT COALESCE(SUM(total), 0) FROM totals)::text AS totals_sum,
                    (SELECT COALESCE(SUM(total), 0) FROM rounds WHERE status IN ('ingested','published'))::text AS rounds_sum`
        );
        if (rows[0].totals_sum !== rows[0].rounds_sum) {
            return [`SUM(totals.total) ${rows[0].totals_sum} != SUM(rounds.total over ingested+published) ${rows[0].rounds_sum}`];
        }
        return [];
    }

    /** Invariant 2: newest tree's stored total_sum / wallet_count match totals at build time. */
    async checkInvariant2(client: PoolClient): Promise<string[]> {
        const { rows } = await client.query(
            `SELECT root, round::text AS round, wallet_count, total_sum::text AS total_sum
             FROM trees ORDER BY created_at DESC LIMIT 1`
        );
        if (rows.length === 0) return [];
        const tree = rows[0];
        const { rows: now } = await client.query(
            `SELECT COALESCE(SUM(total), 0)::text AS sum, COUNT(*)::int AS count FROM totals`
        );
        const violations: string[] = [];
        if (tree.total_sum !== now[0].sum) {
            violations.push(`tree ${tree.root.slice(0, 12)}… total_sum ${tree.total_sum} != SUM(totals.total) ${now[0].sum}`);
        }
        if (tree.wallet_count !== now[0].count) {
            violations.push(`tree ${tree.root.slice(0, 12)}… wallet_count ${tree.wallet_count} != totals rows ${now[0].count}`);
        }
        return violations;
    }

    /** Sum of totals over published rounds (the funded amount F in reconcile). */
    async fundedTotal(client?: PoolClient): Promise<bigint> {
        const { rows } = await this.q(client)(
            `SELECT COALESCE(SUM(total), 0)::text AS funded FROM rounds WHERE status = 'published'`
        );
        return BigInt(rows[0].funded);
    }
}
