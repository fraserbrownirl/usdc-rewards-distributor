#!/usr/bin/env node
import { execFile } from 'child_process';
import { join } from 'path';
import { loadJobConfig } from './config';
import { Alerter } from './alerts';

/**
 * Scheduler — spec §5/§13. Spawns `distributor run` every 15 minutes (the run
 * itself is advisory-locked, so overlapping invocations are safe no-ops).
 * Deadline alerts (file_missing / publish_overdue) fire inside the run —
 * step 12 — deduped once per UTC day via the inbox state file.
 */

const INTERVAL_MS = 15 * 60 * 1000;

function spawnRun(): Promise<number> {
    return new Promise((resolvePromise) => {
        execFile(
            process.execPath,
            [join(__dirname, 'cli.js'), 'run'],
            { env: process.env },
            (error, stdout, stderr) => {
                if (stdout) process.stdout.write(stdout);
                if (stderr) process.stderr.write(stderr);
                resolvePromise(error ? (typeof error.code === 'number' ? error.code : 1) : 0);
            }
        );
    });
}

async function tick(alerter: Alerter): Promise<void> {
    const code = await spawnRun();
    if (code !== 0) {
        // The run's own critical alerts already fired; this marks that the
        // job is stopped until a person intervenes.
        await alerter.critical('publish_failed', `distributor run exited with code ${code}`, { exitCode: code });
    }
}

async function main(): Promise<void> {
    const cfg = loadJobConfig();
    const alerter = new Alerter(cfg.alertWebhookUrl);
    console.log(`scheduler: run every ${INTERVAL_MS / 60000} min, inbox=${cfg.inboxDir}`);
    await tick(alerter);
    setInterval(() => {
        tick(alerter).catch((e) => console.error(`tick failed: ${(e as Error).message}`));
    }, INTERVAL_MS);
}

main().catch((e) => {
    console.error(`fatal: ${(e as Error).message}`);
    process.exit(1);
});
