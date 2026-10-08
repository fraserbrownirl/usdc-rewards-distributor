import { readdirSync, readFileSync, renameSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { PoolClient } from 'pg';
import { Db } from './db';
import { FileReject, fileSha256, isValidRoundName, validateRoundFile, RoundFile } from './fileValidation';

/**
 * Inbox IO — spec §6. One round file per UTC day, `INBOX_DIR/<round>.json`.
 * The job ingests AT MOST ONE file per run: the earliest valid pending round
 * (monotonic rule means later files can only be ingested after it). Rejected
 * files are moved aside with an error note and never block later rounds…
 * except that a rejected EARLIER round does block later ones by the monotonic
 * rule, which is intended: gaps are not allowed.
 */

export interface IngestResult {
    action: 'ingested' | 'noop' | 'rejected' | 'none';
    round?: string;
    detail?: string;
}

function ensureDir(dir: string): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** List candidate round files in the inbox, sorted ascending by round name. */
export function listInboxFiles(inboxDir: string): string[] {
    if (!existsSync(inboxDir)) return [];
    return readdirSync(inboxDir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .sort();
}

/**
 * Attempt to ingest the earliest pending file. The caller holds the advisory
 * lock and passes its `client`; standalone use (tests) omits it and the pool
 * is used for reads, a fresh client for the write tx.
 */
export async function ingestEarliest(db: Db, inboxDir: string, client?: PoolClient): Promise<IngestResult> {
    const processedDir = join(inboxDir, 'processed');
    const rejectedDir = join(inboxDir, 'rejected');
    ensureDir(processedDir);
    ensureDir(rejectedDir);

    const candidates = listInboxFiles(inboxDir);
    if (candidates.length === 0) return { action: 'none' };

    const fileName = candidates[0];
    const round = fileName.replace(/\.json$/, '');
    const raw = readFileSync(join(inboxDir, fileName));

    const prev = await db.lastIngestedRound(client);
    const totals = await db.allTotals(client);

    // Same-round identical re-delivery: no-op, move to processed.
    if (prev && prev.round === round && prev.file_sha256 === fileSha256(raw)) {
        renameSync(join(inboxDir, fileName), join(processedDir, fileName));
        return { action: 'noop', round, detail: 'identical re-delivery of last ingested round' };
    }

    let parsed: RoundFile;
    try {
        parsed = validateRoundFile(fileName, raw, { round: prev?.round ?? null, fileSha256: prev?.file_sha256 ?? null }, totals);
    } catch (e) {
        if (e instanceof FileReject) {
            renameSync(join(inboxDir, fileName), join(rejectedDir, fileName));
            writeFileSync(
                join(rejectedDir, `${round}.error.txt`),
                `rule: ${e.rule}\n${e.message}\nrejected_at: ${new Date().toISOString()}\n`
            );
            return { action: 'rejected', round, detail: `${e.rule}: ${e.message}` };
        }
        throw e;
    }

    if (client) {
        await db.ingestRound(client, parsed.round, parsed.sha256, parsed.total, parsed.rewards);
    } else {
        const c = await db.pool.connect();
        try {
            await db.ingestRound(c, parsed.round, parsed.sha256, parsed.total, parsed.rewards);
        } finally {
            c.release();
        }
    }
    renameSync(join(inboxDir, fileName), join(processedDir, fileName));
    return {
        action: 'ingested',
        round: parsed.round,
        detail: `${parsed.rewards.length} wallets, total ${parsed.total}`,
    };
}
