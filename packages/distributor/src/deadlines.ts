import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Db } from './db';
import { JobConfig } from './config';
import { Alerter, pastUtcHour, utcYesterday } from './alerts';

/**
 * Deadline alerts — spec §8 step 12:
 *   file_missing (warning):   yesterday's file hasn't arrived by 02:00 UTC
 *   publish_overdue (high):   yesterday's round isn't published/empty by
 *                             06:00 UTC
 *
 * Each alert fires at most once per UTC day. The last-fired dates live in a
 * small state file next to the inbox (the job host already owns that
 * directory) so dedupe survives process restarts — the scheduler spawns a
 * fresh `distributor run` every 15 minutes, making in-process dedupe useless.
 */

const FILE_DEADLINE_HOUR = 2;
const PUBLISH_DEADLINE_HOUR = 6;

function statePath(inboxDir: string): string {
    return join(inboxDir, '.alert-state.json');
}

function loadState(inboxDir: string): Record<string, string> {
    try {
        return JSON.parse(readFileSync(statePath(inboxDir), 'utf8'));
    } catch {
        return {};
    }
}

export async function deadlineAlerts(db: Db, cfg: JobConfig, alerter: Alerter): Promise<void> {
    const yesterday = utcYesterday();
    const state = loadState(cfg.inboxDir);
    let dirty = false;

    if (pastUtcHour(FILE_DEADLINE_HOUR) && state.file_missing !== yesterday) {
        const { rows } = await db.pool.query(`SELECT 1 FROM rounds WHERE round = $1`, [yesterday]);
        const arrived =
            rows.length > 0 ||
            existsSync(join(cfg.inboxDir, `${yesterday}.json`)) ||
            existsSync(join(cfg.inboxDir, 'rejected', `${yesterday}.json`));
        if (!arrived) {
            await alerter.warning('file_missing', `no round file for ${yesterday} after 0${FILE_DEADLINE_HOUR}:00 UTC`, {
                round: yesterday,
            });
            state.file_missing = yesterday;
            dirty = true;
        }
    }

    if (pastUtcHour(PUBLISH_DEADLINE_HOUR) && state.publish_overdue !== yesterday) {
        const { rows } = await db.pool.query(`SELECT status FROM rounds WHERE round = $1`, [yesterday]);
        const status: string | undefined = rows[0]?.status;
        if (status === 'ingested') {
            await alerter.error('publish_overdue', `round ${yesterday} still not published after 0${PUBLISH_DEADLINE_HOUR}:00 UTC`, {
                round: yesterday,
            });
            state.publish_overdue = yesterday;
            dirty = true;
        }
    }

    if (dirty) writeFileSync(statePath(cfg.inboxDir), JSON.stringify(state, null, 2) + '\n');
}
