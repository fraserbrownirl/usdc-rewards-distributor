#!/usr/bin/env node
import { execFileSync } from 'child_process';
import { join } from 'path';
import { loadConfig } from './config';
import { Db } from './db';
import { Alerter, utcNow } from './alerts';
import { listInboxFiles } from './ingest';

/**
 * Scheduler — spec §5/§13. Runs `distributor run` every 15 minutes (the run
 * itself is advisory-locked, so overlapping invocations are safe no-ops) and
 * fires deadline alerts: today's file missing after 02:00 UTC, an ingested
 * round still unpublished after 06:00 UTC. Alerts fire at most once per day
 * per code (tracked in-process; a restart may re-fire once, which is fine).
 */

const INTERVAL_MS = 15 * 60 * 1000;
const FILE_DEADLINE_HOUR = 2;
const PUBLISH_DEADLINE_HOUR = 6;

async function tick(cfg: ReturnType<typeof loadConfig>, alerter: Alerter, fired: Set<string>): Promise<void> {
    const cliPath = join(__dirname, 'cli.js');
    try {
        execFileSync(process.execPath, [cliPath, 'run'], { stdio: 'inherit', env: process.env });
    } catch (e) {
        await alerter.critical('publish_failed', 'distributor run exited non-zero', {
            error: (e as Error).message,
        });
    }

    const { date, hour } = utcNow();
    const db = new Db(cfg.databaseUrl);
    try {
        if (hour >= FILE_DEADLINE_HOUR && !fired.has(`file_missing:${date}`)) {
            const files = listInboxFiles(cfg.inboxDir);
            const last = await db.lastIngestedRound();
            const todayCovered = files.includes(`${date}.json`) || last?.round === date;
            if (!todayCovered) {
                fired.add(`file_missing:${date}`);
                await alerter.warning('file_missing', `no round file for ${date} after 0${FILE_DEADLINE_HOUR}:00 UTC`, { date });
            }
        }
        if (hour >= PUBLISH_DEADLINE_HOUR && !fired.has(`publish_overdue:${date}`)) {
            const pending = await db.pendingIngestedRound();
            if (pending) {
                fired.add(`publish_overdue:${date}`);
                await alerter.warning('publish_overdue', `round ${pending.round} ingested but not published after 0${PUBLISH_DEADLINE_HOUR}:00 UTC`, {
                    round: pending.round,
                });
            }
        }
    } finally {
        await db.close();
    }
}

async function main(): Promise<void> {
    const cfg = loadConfig();
    const alerter = new Alerter(cfg.alertWebhookUrl);
    const fired = new Set<string>();
    console.log(`scheduler: run every ${INTERVAL_MS / 60000} min, inbox=${cfg.inboxDir}`);
    await tick(cfg, alerter, fired);
    setInterval(() => {
        tick(cfg, alerter, fired).catch((e) => console.error(`tick failed: ${(e as Error).message}`));
    }, INTERVAL_MS);
}

main().catch((e) => {
    console.error(`fatal: ${(e as Error).message}`);
    process.exit(1);
});
