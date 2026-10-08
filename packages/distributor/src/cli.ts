#!/usr/bin/env node
import { readFileSync } from 'fs';
import { Keypair } from '@solana/web3.js';
import { loadConfig } from './config';
import { Db } from './db';
import { ingestEarliest } from './ingest';
import { publishPendingRound } from './publish';
import { reconcile } from './reconcile';
import { Alerter } from './alerts';
import { fileSha256, validateRoundFile } from './fileValidation';
import { join } from 'path';

/**
 * CLI — spec §5. One command per operational action; `run` is the daily job
 * (advisory-locked: ingest → publish → reconcile). Exit codes: 0 ok,
 * 1 failure, 2 usage.
 */

function loadOperator(path: string): Keypair {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main(): Promise<number> {
    const [cmd, ...args] = process.argv.slice(2);
    const cfg = loadConfig();
    const db = new Db(cfg.databaseUrl);
    const alerter = new Alerter(cfg.alertWebhookUrl);
    const migrationsDir = join(__dirname, '..', '..', '..', 'migrations');

    try {
        switch (cmd) {
            case 'migrate': {
                const applied = await db.migrate(migrationsDir);
                console.log(applied.length ? `applied migrations: ${applied.join(', ')}` : 'no pending migrations');
                return 0;
            }

            case 'run': {
                const operator = loadOperator(cfg.operatorKeypairPath);
                const result = await db.withAdvisoryLock(async (client) => {
                    const ingest = await ingestEarliest(db, cfg.inboxDir, client);
                    console.log(`ingest: ${ingest.action}${ingest.round ? ` ${ingest.round}` : ''}${ingest.detail ? ` (${ingest.detail})` : ''}`);
                    if (ingest.action === 'rejected') {
                        await alerter.warning('file_rejected', `round file rejected: ${ingest.detail}`, { round: ingest.round });
                    }

                    const publish = await publishPendingRound(db, cfg, operator, alerter, client);
                    console.log(`publish: ${publish.action}${publish.round ? ` ${publish.round}` : ''}${publish.root ? ` root=${publish.root.slice(0, 12)}…` : ''}${publish.signature ? ` sig=${publish.signature}` : ''}`);
                    if (publish.action === 'published') {
                        await alerter.info('published', `round ${publish.round} published`, publish as unknown as Record<string, unknown>);
                    }

                    const report = await reconcile(db, cfg, client);
                    if (!report.ok) {
                        for (const v of report.violations) console.error(`reconcile: ${v}`);
                        await alerter.critical('reconcile_failed', 'reconciliation violations', { violations: report.violations });
                        return 1;
                    }
                    console.log(`reconcile: ok (funded=${report.numbers.funded} claimed=${report.numbers.claimed} vault=${report.numbers.vault})`);
                    return 0;
                });
                if (result === null) {
                    console.log('another run holds the advisory lock — exiting');
                    return 0;
                }
                return result;
            }

            case 'reconcile': {
                const client = await db.pool.connect();
                try {
                    const report = await reconcile(db, cfg, client);
                    console.log(JSON.stringify(report, null, 2));
                    return report.ok ? 0 : 1;
                } finally {
                    client.release();
                }
            }

            case 'status': {
                const last = await db.lastIngestedRound();
                const pending = await db.pendingIngestedRound();
                console.log(JSON.stringify({ lastIngested: last, pendingPublish: pending?.round ?? null }, null, 2));
                return 0;
            }

            case 'verify-file': {
                const file = args[0];
                if (!file) {
                    console.error('usage: distributor verify-file <path/to/YYYY-MM-DD.json>');
                    return 2;
                }
                const raw = readFileSync(file);
                const fileName = file.split('/').pop()!;
                const prev = await db.lastIngestedRound();
                const totals = await db.allTotals();
                try {
                    const parsed = validateRoundFile(
                        fileName,
                        raw,
                        { round: prev?.round ?? null, fileSha256: prev?.file_sha256 ?? null },
                        totals
                    );
                    console.log(`valid: round ${parsed.round}, ${parsed.rewards.length} wallets, total ${parsed.total}, sha256 ${fileSha256(raw)}`);
                    return 0;
                } catch (e) {
                    console.error(`invalid: ${(e as Error).message}`);
                    return 1;
                }
            }

            case 'export-outstanding': {
                const { rows } = await db.pool.query(
                    `SELECT wallet, total::text, claim_record::text, (total - claim_record)::text AS outstanding
                     FROM totals WHERE total > claim_record ORDER BY wallet`
                );
                console.log(JSON.stringify(rows, null, 2));
                return 0;
            }

            default:
                console.error('usage: distributor <migrate|run|reconcile|status|verify-file|export-outstanding>');
                return cmd ? 2 : (console.error(''), 2);
        }
    } finally {
        await db.close();
    }
}

main()
    .then((code) => process.exit(code))
    .catch((e) => {
        console.error(`fatal: ${(e as Error).message}`);
        process.exit(1);
    });
