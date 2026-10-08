import Fastify from 'fastify';
import { Pool } from 'pg';
import { Connection, PublicKey } from '@solana/web3.js';
import {
    Alerter,
    claimedPda,
    configPda,
    deriveVault,
    fetchOnChainConfig,
    loadApiConfig,
    OnChainConfig,
    parseClaimedAmount,
    ZERO_ROOT_HEX,
} from '@podminer/distributor';

/**
 * Read-only rewards API — spec §9. Serves proofs for the CURRENT ON-CHAIN
 * ROOT (not the newest DB tree), with the claimed amount read live from the
 * wallet's ClaimedRewards record at confirmed. No writes, no auth — proofs
 * are public data; the on-chain verifier is the security boundary.
 *
 *   GET /healthz                        — 200 when DB and RPC are reachable
 *   GET /v1/rewards/:wallet             — total/claimed/claimable/proof
 *   GET /v1/rewards/:wallet/history     — published rounds, newest first
 *   GET /v1/status                      — program/config/vault/root numbers
 *
 * 503 {"error":"shutdown"} when the on-chain shutdown flag is set;
 * 503 {"error":"tree_unavailable"} (+ critical alert) when the on-chain root
 * has no stored tree. CORS restricted to CORS_ORIGINS; per-IP rate limit.
 */

const ROOT_CACHE_MS = 10_000;

interface RootSnapshot {
    fetchedAt: number;
    onchain: OnChainConfig;
    rootHex: string;
    /** Tree row for the on-chain root; null when missing (tree_unavailable). */
    tree: { root: string; round: string; wallet_count: number; total_sum: string } | null;
}

function isBase58Pubkey(s: string): boolean {
    try {
        new PublicKey(s);
        return true;
    } catch {
        return false;
    }
}

async function main(): Promise<void> {
    const cfg = loadApiConfig();
    const pool = new Pool({ connectionString: cfg.databaseUrl, max: 4 });
    const connection = new Connection(cfg.rpcUrl, 'confirmed');
    const programId = new PublicKey(cfg.programId);
    const mint = new PublicKey(cfg.usdcMint);
    const vault = deriveVault(mint, programId);
    const alerter = new Alerter(cfg.alertWebhookUrl);
    const app = Fastify({ logger: true });

    // CORS: empty list = no CORS headers (same-origin only).
    app.addHook('onSend', async (req, reply) => {
        const origin = req.headers.origin;
        if (origin && cfg.corsOrigins.includes(origin)) {
            reply.header('access-control-allow-origin', origin);
            reply.header('vary', 'origin');
        }
    });

    // Naive per-IP fixed-window limiter; sufficient behind one replica.
    const buckets = new Map<string, { count: number; resetAt: number }>();
    app.addHook('onRequest', async (req, reply) => {
        const now = Date.now();
        const b = buckets.get(req.ip);
        if (!b || now > b.resetAt) {
            buckets.set(req.ip, { count: 1, resetAt: now + 60_000 });
        } else if (++b.count > cfg.rateLimitPerMin) {
            reply.code(429).send({ error: 'rate_limit' });
        }
    });

    let cache: RootSnapshot | null = null;
    async function snapshot(): Promise<RootSnapshot> {
        if (cache && Date.now() - cache.fetchedAt < ROOT_CACHE_MS) return cache;
        const onchain = await fetchOnChainConfig(connection, programId);
        const rootHex = Buffer.from(onchain.root).toString('hex');
        let tree: RootSnapshot['tree'] = null;
        if (rootHex !== ZERO_ROOT_HEX) {
            const { rows } = await pool.query(
                `SELECT root, round::text AS round, wallet_count, total_sum::text AS total_sum FROM trees WHERE root = $1`,
                [rootHex]
            );
            tree = rows[0] ?? null;
            if (!tree) {
                // Alert at most once per root — the job's root_mismatch check
                // is the steady-state guard; this covers API-visible gaps.
                await alerter.critical('tree_unavailable', `on-chain root ${rootHex} has no stored tree`, {
                    root: rootHex,
                });
            }
        }
        cache = { fetchedAt: Date.now(), onchain, rootHex, tree };
        return cache;
    }

    app.get('/healthz', async (_req, reply) => {
        try {
            await pool.query('SELECT 1');
            await connection.getLatestBlockhash('confirmed');
            return { ok: true };
        } catch (e) {
            return reply.code(503).send({ ok: false, error: (e as Error).message });
        }
    });

    app.get<{ Params: { wallet: string } }>('/v1/rewards/:wallet', async (req, reply) => {
        if (!isBase58Pubkey(req.params.wallet)) return reply.code(400).send({ error: 'invalid wallet' });
        const wallet = new PublicKey(req.params.wallet);
        const snap = await snapshot();
        if (snap.onchain.shutdown) return reply.code(503).send({ error: 'shutdown' });
        if (snap.rootHex !== ZERO_ROOT_HEX && !snap.tree) {
            return reply.code(503).send({ error: 'tree_unavailable' });
        }

        // Claimed: live from the wallet's claim record at confirmed.
        const claimedAcc = await connection.getAccountInfo(claimedPda(programId, wallet), 'confirmed');
        const claimed = claimedAcc ? parseClaimedAmount(claimedAcc.data as Buffer) : 0n;

        let total = 0n;
        let proofHex: string[] = [];
        let round: string | null = null;
        if (snap.tree) {
            round = snap.tree.round;
            const { rows } = await pool.query(
                `SELECT total::text AS total, proof FROM proofs WHERE root = $1 AND wallet = $2`,
                [snap.rootHex, req.params.wallet]
            );
            if (rows.length > 0) {
                total = BigInt(rows[0].total);
                const raw = rows[0].proof as Buffer;
                proofHex = raw.toString('hex').match(/.{64}/g) ?? [];
            }
        }
        const claimable = total > claimed ? total - claimed : 0n;
        return {
            wallet: req.params.wallet,
            root: snap.rootHex === ZERO_ROOT_HEX ? null : snap.rootHex,
            round,
            total: total.toString(),
            claimed: claimed.toString(),
            claimable: claimable.toString(),
            proof: proofHex,
            program_id: cfg.programId,
            mint: cfg.usdcMint,
        };
    });

    app.get<{ Params: { wallet: string }; Querystring: { limit?: string } }>(
        '/v1/rewards/:wallet/history',
        async (req, reply) => {
            if (!isBase58Pubkey(req.params.wallet)) return reply.code(400).send({ error: 'invalid wallet' });
            const snap = await snapshot();
            if (snap.onchain.shutdown) return reply.code(503).send({ error: 'shutdown' });
            let limit = 90;
            if (req.query.limit !== undefined) {
                limit = Number(req.query.limit);
                if (!Number.isInteger(limit) || limit < 1 || limit > 365) {
                    return reply.code(400).send({ error: 'limit must be an integer 1..365' });
                }
            }
            const { rows } = await pool.query(
                `SELECT rr.round::text AS round, rr.amount::text AS amount
                 FROM round_rewards rr
                 JOIN rounds r ON r.round = rr.round AND r.status = 'published'
                 WHERE rr.wallet = $1
                 ORDER BY rr.round DESC
                 LIMIT $2`,
                [req.params.wallet, limit]
            );
            return { wallet: req.params.wallet, history: rows };
        }
    );

    app.get('/v1/status', async (_req, reply) => {
        const snap = await snapshot();
        if (snap.onchain.shutdown) return reply.code(503).send({ error: 'shutdown' });
        const vaultBal = await connection
            .getTokenAccountBalance(vault, 'confirmed')
            .then((b) => b.value.amount)
            .catch(() => null);
        const { rows } = await pool.query(
            `SELECT round::text AS round FROM rounds WHERE status = 'published' ORDER BY round DESC LIMIT 1`
        );
        return {
            program_id: cfg.programId,
            config: configPda(programId).toBase58(),
            vault: vault.toBase58(),
            mint: cfg.usdcMint,
            root: snap.rootHex === ZERO_ROOT_HEX ? null : snap.rootHex,
            round: rows[0]?.round ?? null,
            wallet_count: snap.tree?.wallet_count ?? 0,
            vault_balance: vaultBal,
            shutdown: snap.onchain.shutdown,
        };
    });

    await app.listen({ port: cfg.apiPort, host: '0.0.0.0' });
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
