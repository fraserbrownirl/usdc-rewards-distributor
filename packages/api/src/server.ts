import Fastify from 'fastify';
import { Pool } from 'pg';
import { loadConfig } from '@podminer/distributor';

/**
 * Read-only claims API — spec §11. Serves Merkle proofs and round status to
 * claimants' wallets. No writes, no auth (proofs are public data; the
 * security boundary is the on-chain verifier). CORS is restricted to
 * CORS_ORIGINS; per-IP rate limiting at RATE_LIMIT_PER_MIN.
 *
 *   GET /healthz
 *   GET /v1/rounds                       — recent rounds, newest first
 *   GET /v1/rounds/:round                — one round's status
 *   GET /v1/claims/:wallet               — wallet's current total + proof
 *   GET /v1/reconcile                    — last reconciliation numbers
 */

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ROUND_RE = /^\d{4}-\d{2}-\d{2}$/;

interface RateBucket {
    count: number;
    resetAt: number;
}

async function main(): Promise<void> {
    const cfg = loadConfig();
    const pool = new Pool({ connectionString: cfg.databaseUrl, max: 4 });
    const app = Fastify({ logger: true });

    // CORS: empty list = same-origin only (no CORS headers).
    app.addHook('onSend', async (req, reply) => {
        const origin = req.headers.origin;
        if (origin && cfg.corsOrigins.includes(origin)) {
            reply.header('access-control-allow-origin', origin);
            reply.header('vary', 'origin');
        }
    });

    // Naive per-IP fixed-window limiter; sufficient behind one replica.
    const buckets = new Map<string, RateBucket>();
    app.addHook('onRequest', async (req, reply) => {
        const now = Date.now();
        const key = req.ip;
        const b = buckets.get(key);
        if (!b || now > b.resetAt) {
            buckets.set(key, { count: 1, resetAt: now + 60_000 });
        } else if (++b.count > cfg.rateLimitPerMin) {
            reply.code(429).send({ error: 'rate limit exceeded' });
        }
    });

    app.get('/healthz', async () => ({ ok: true }));

    app.get('/v1/rounds', async () => {
        const { rows } = await pool.query(
            `SELECT round::text, status, total::text, wallet_count, root,
                    publish_signature, created_at, updated_at
             FROM rounds ORDER BY round DESC LIMIT 60`
        );
        return { rounds: rows };
    });

    app.get<{ Params: { round: string } }>('/v1/rounds/:round', async (req, reply) => {
        if (!ROUND_RE.test(req.params.round)) return reply.code(400).send({ error: 'bad round' });
        const { rows } = await pool.query(
            `SELECT round::text, status, total::text, wallet_count, root,
                    publish_signature, publish_slot, created_at, updated_at
             FROM rounds WHERE round = $1`,
            [req.params.round]
        );
        if (rows.length === 0) return reply.code(404).send({ error: 'round not found' });
        return rows[0];
    });

    app.get<{ Params: { wallet: string } }>('/v1/claims/:wallet', async (req, reply) => {
        if (!BASE58_RE.test(req.params.wallet)) return reply.code(400).send({ error: 'bad wallet' });
        const { rows: trows } = await pool.query(
            `SELECT total::text, claim_record::text, updated_round::text FROM totals WHERE wallet = $1`,
            [req.params.wallet]
        );
        if (trows.length === 0) return reply.code(404).send({ error: 'wallet not found' });

        // Proof from the newest published round's tree (the on-chain root).
        const { rows: prows } = await pool.query(
            `SELECT p.proof, t.root, t.round::text
             FROM proofs p
             JOIN trees t ON t.root = p.root
             JOIN rounds r ON r.root = t.root AND r.status = 'published'
             WHERE p.wallet = $1
             ORDER BY t.created_at DESC LIMIT 1`,
            [req.params.wallet]
        );
        const total = trows[0].total as string;
        return {
            wallet: req.params.wallet,
            total,
            claimed: trows[0].claim_record,
            outstanding: (BigInt(total) - BigInt(trows[0].claim_record)).toString(),
            updatedRound: trows[0].updated_round,
            proof: prows.length
                ? {
                      root: prows[0].root,
                      round: prows[0].round,
                      hashes: Buffer.from(prows[0].proof as Buffer)
                          .toString('hex')
                          .match(/.{64}/g) ?? [],
                  }
                : null, // tree not published yet — claimant waits
        };
    });

    app.get('/v1/reconcile', async () => {
        const { rows } = await pool.query(
            `SELECT COALESCE(SUM(total), 0)::text AS funded FROM rounds WHERE status = 'published'`
        );
        const { rows: crows } = await pool.query(
            `SELECT COALESCE(SUM(claim_record), 0)::text AS claimed, COALESCE(SUM(total), 0)::text AS owed FROM totals`
        );
        return { funded: rows[0].funded, claimed: crows[0].claimed, owed: crows[0].owed };
    });

    await app.listen({ port: cfg.apiPort, host: '0.0.0.0' });
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
