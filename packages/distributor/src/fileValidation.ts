import { createHash } from 'crypto';
import { PublicKey } from '@solana/web3.js';

/**
 * Daily round file validation — spec §6. Nine all-or-nothing rules; any
 * failure rejects the whole file (moved to rejected/ with an error note).
 *
 * File: INBOX_DIR/<round>.json
 * {
 *   "version": 1,
 *   "round": "YYYY-MM-DD",
 *   "total": "<decimal u64>",
 *   "count": <int>,
 *   "rewards": [{ "wallet": "<base58>", "amount": "<decimal u64>" }, ...]
 * }
 */

export interface RoundReward {
    wallet: string; // base58
    amount: bigint;
}

export interface RoundFile {
    round: string; // YYYY-MM-DD, must equal the file name
    total: bigint;
    rewards: RoundReward[];
    sha256: string; // of the raw file bytes
}

export class FileReject extends Error {
    constructor(
        public readonly rule: string,
        message: string
    ) {
        super(message);
        this.name = 'FileReject';
    }
}

const ROUND_RE = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT_RE = /^[1-9][0-9]*$/;
const U64_MAX = (1n << 64n) - 1n;

export function isValidRoundName(name: string): boolean {
    if (!ROUND_RE.test(name)) return false;
    const d = new Date(name + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === name;
}

export function fileSha256(raw: Buffer): string {
    return createHash('sha256').update(raw).digest('hex');
}

/**
 * Validate one round file. `prev` carries the last ingested round name and
 * its file sha (for the same-round no-op exception). Pure function — IO
 * lives in ingest.ts.
 */
export function validateRoundFile(
    fileName: string,
    raw: Buffer,
    prev: { round: string | null; fileSha256: string | null },
    totalsSumByWallet: Map<string, bigint>
): RoundFile {
    // Rule 1: parse + schema
    let json: any;
    try {
        json = JSON.parse(raw.toString('utf8'));
    } catch {
        throw new FileReject('parse', 'file is not valid JSON');
    }
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
        throw new FileReject('parse', 'top level must be an object');
    }
    if (json.version !== 1) throw new FileReject('parse', `version must be 1, got ${json.version}`);
    if (typeof json.round !== 'string' || typeof json.total !== 'string' || !Array.isArray(json.rewards)) {
        throw new FileReject('parse', 'fields round (string), total (string), rewards (array) are required');
    }
    if (typeof json.count !== 'number' || !Number.isInteger(json.count)) {
        throw new FileReject('parse', 'count must be an integer');
    }

    const sha = fileSha256(raw);
    const round = json.round as string;

    // Rule 2: round == file name, valid past-or-today date, monotonic.
    // Same-round re-delivery of the identical file is a no-op (caller checks).
    const expectedName = `${round}.json`;
    if (fileName !== expectedName) {
        throw new FileReject('round', `file name '${fileName}' does not match round '${round}'`);
    }
    if (!isValidRoundName(round)) {
        throw new FileReject('round', `round '${round}' is not a valid calendar date`);
    }
    const today = new Date().toISOString().slice(0, 10);
    if (round > today) {
        throw new FileReject('round', `round '${round}' is in the future`);
    }
    if (prev.round !== null) {
        if (round === prev.round && prev.fileSha256 === sha) {
            // identical re-delivery — caller treats as no-op
        } else if (round <= prev.round) {
            throw new FileReject(
                'round',
                `round '${round}' is not after the last ingested round '${prev.round}'`
            );
        }
    }

    // Rule 3: count matches
    if (json.rewards.length !== json.count) {
        throw new FileReject('count', `count ${json.count} != rewards length ${json.rewards.length}`);
    }
    if (json.count === 0) {
        throw new FileReject('count', 'round has zero rewards (empty rounds are never ingested)');
    }

    // Rules 4–7: wallets valid & unique, amounts valid
    const seen = new Set<string>();
    const parsed: RoundReward[] = [];
    for (let i = 0; i < json.rewards.length; i++) {
        const r = json.rewards[i];
        if (typeof r !== 'object' || r === null || typeof r.wallet !== 'string' || typeof r.amount !== 'string') {
            throw new FileReject('schema', `rewards[${i}] must have wallet and amount strings`);
        }
        let pk: PublicKey;
        try {
            pk = new PublicKey(r.wallet);
        } catch {
            throw new FileReject('wallet', `rewards[${i}].wallet '${r.wallet}' is not valid base58`);
        }
        if (!PublicKey.isOnCurve(pk.toBytes())) {
            throw new FileReject('wallet', `rewards[${i}].wallet '${r.wallet}' is off-curve (PDA)`);
        }
        if (seen.has(r.wallet)) {
            throw new FileReject('duplicate', `duplicate wallet '${r.wallet}'`);
        }
        seen.add(r.wallet);
        if (!AMOUNT_RE.test(r.amount)) {
            throw new FileReject('amount', `rewards[${i}].amount '${r.amount}' is not a positive decimal integer`);
        }
        const amount = BigInt(r.amount);
        if (amount > U64_MAX) {
            throw new FileReject('amount', `rewards[${i}].amount exceeds u64`);
        }
        parsed.push({ wallet: r.wallet, amount });
    }

    // Rule 8: sum == total
    const sum = parsed.reduce((a, r) => a + r.amount, 0n);
    const total = BigInt(json.total);
    if (!AMOUNT_RE.test(json.total)) {
        throw new FileReject('total', `total '${json.total}' is not a positive decimal integer`);
    }
    if (sum !== total) {
        throw new FileReject('total', `rewards sum ${sum} != declared total ${total}`);
    }

    // Rule 9: u64 lifetime overflow check against existing totals
    for (const r of parsed) {
        const existing = totalsSumByWallet.get(r.wallet) ?? 0n;
        if (existing + r.amount > U64_MAX) {
            throw new FileReject(
                'overflow',
                `wallet '${r.wallet}' lifetime total would exceed u64 (${existing} + ${r.amount})`
            );
        }
    }

    return { round, total, rewards: parsed, sha256: sha };
}
