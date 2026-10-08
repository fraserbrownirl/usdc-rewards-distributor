import { Pool, PoolClient } from 'pg';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/** Postgres access layer for the distributor ledger. */

export interface RoundRow {
    round: string; // YYYY-MM-DD
    file_sha256: string;
    total: string; // numeric as string
    wallet_count: number;
    status: 'ingested' | 'published' | 'empty';
    root: string | null;
    publish_signature: string | null;
    publish_slot: number | null;
    publish_last_valid_block_height: number | null;
}

export class Db {
    public readonly pool: Pool;

    constructor(databaseUrl: string) {
        this.pool = new Pool({ connectionString: databaseUrl, max: 4 });
    }

    async close(): Promise<void> {
        await this.pool.end();
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
        const q = (client ?? this.pool).query.bind(client ?? this.pool);
        const { rows } = await q(
            `SELECT round::text, file_sha256 FROM rounds ORDER BY round DESC LIMIT 1`
        );
        return rows[0] ?? null;
    }

    async pendingIngestedRound(client?: PoolClient): Promise<RoundRow | null> {
        const q = (client ?? this.pool).query.bind(client ?? this.pool);
        const { rows } = await q(`SELECT round::text, * FROM rounds WHERE status = 'ingested' LIMIT 1`);
        return rows[0] ?? null;
    }

    async allTotals(client?: PoolClient): Promise<Map<string, bigint>> {
        const q = (client ?? this.pool).query.bind(client ?? this.pool);
        const { rows } = await q(`SELECT wallet, total::text AS total FROM totals`);
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
                    `INSERT INTO totals (wallet, total, updated_round) VALUES ($1, $2, $3)
                     ON CONFLICT (wallet) DO UPDATE SET total = totals.total + EXCLUDED.total,
                                                        updated_round = EXCLUDED.updated_round`,
                    [r.wallet, r.amount.toString(), round]
                );
            }
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        }
    }

    async storeTree(client: PoolClient, root: string, round: string, proofs: Map<string, Buffer>): Promise<void> {
        await client.query('BEGIN');
        try {
            await client.query(`INSERT INTO trees (root, round) VALUES ($1, $2) ON CONFLICT (root) DO NOTHING`, [
                root,
                round,
            ]);
            for (const [wallet, proof] of proofs) {
                await client.query(
                    `INSERT INTO proofs (root, wallet, proof) VALUES ($1, $2, $3)
                     ON CONFLICT (root, wallet) DO NOTHING`,
                    [root, wallet, proof]
                );
            }
            await client.query(
                `UPDATE rounds SET root = $2, updated_at = now() WHERE round = $1`,
                [round, root]
            );
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        }
    }

    async markPublished(
        client: PoolClient,
        round: string,
        signature: string,
        slot: number,
        lastValidBlockHeight: number
    ): Promise<void> {
        await client.query(
            `UPDATE rounds SET status = 'published', publish_signature = $2, publish_slot = $3,
                publish_last_valid_block_height = $4, updated_at = now()
             WHERE round = $1`,
            [round, signature, slot, lastValidBlockHeight]
        );
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

    /** Invariant 1: sum(round_rewards) per round == rounds.total. */
    async checkInvariant1(client: PoolClient): Promise<string[]> {
        const { rows } = await client.query(
            `SELECT r.round::text, r.total::text, COALESCE(SUM(rr.amount), 0)::text AS actual
             FROM rounds r LEFT JOIN round_rewards rr ON rr.round = r.round
             GROUP BY r.round, r.total
             HAVING r.total <> COALESCE(SUM(rr.amount), 0)`
        );
        return rows.map((r) => `round ${r.round}: declared ${r.total} != rewards sum ${r.actual}`);
    }

    /** Invariant 2: newest tree's implied totals == totals table. */
    async checkInvariant2(client: PoolClient): Promise<string[]> {
        const { rows } = await client.query(
            `SELECT t.root, t.round::text FROM trees t ORDER BY t.created_at DESC LIMIT 1`
        );
        if (rows.length === 0) return [];
        const newest = rows[0];
        const { rows: mismatches } = await client.query(
            `SELECT COALESCE(t.wallet, a.wallet) AS wallet,
                    t.total::text AS totals_total, a.recomputed::text AS recomputed_total
             FROM totals t
             FULL OUTER JOIN (
                 SELECT wallet, SUM(amount) AS recomputed
                 FROM round_rewards WHERE round <= $1 GROUP BY wallet
             ) a ON a.wallet = t.wallet
             WHERE t.total IS DISTINCT FROM a.recomputed`,
            [newest.round]
        );
        return mismatches.map(
            (r: any) =>
                `tree ${newest.root.slice(0, 12)}… (${newest.round}): wallet ${r.wallet} ` +
                `totals=${r.totals_total ?? 'absent'} recomputed=${r.recomputed_total ?? 'absent'}`
        );
    }

    /** Invariant 3 data: vault balance + sum(claimed) >= sum(funded). */
    async reconciliationNumbers(client: PoolClient): Promise<{
        funded: bigint;
        claimed: bigint;
    }> {
        const { rows } = await client.query(
            `SELECT COALESCE(SUM(total), 0)::text AS funded FROM rounds WHERE status = 'published'`
        );
        const { rows: claimedRows } = await client.query(
            `SELECT COALESCE(SUM(claim_record), 0)::text AS claimed FROM totals`
        );
        return { funded: BigInt(rows[0].funded), claimed: BigInt(claimedRows[0].claimed) };
    }
}
