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
 * An empty day is "total": "0", "count": 0, "rewards": [].
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
    /** True when the file is the empty-day form (total 0, count 0, no rows). */
    isEmpty: boolean;
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
const TOP_LEVEL_KEYS = new Set(['version', 'round', 'total', 'count', 'rewards']);
const REWARD_KEYS = new Set(['wallet', 'amount']);

export function isValidRoundName(name: string): boolean {
    if (!ROUND_RE.test(name)) return false;
    const d = new Date(name + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === name;
}

export function fileSha256(raw: Buffer): string {
    return createHash('sha256').update(raw).digest('hex');
}

function checkKeys(obj: Record<string, unknown>, allowed: Set<string>, where: string): void {
    for (const k of Object.keys(obj)) {
        if (!allowed.has(k)) throw new FileReject('schema', `${where}: unexpected key '${k}'`);
    }
}

/**
 * Validate one round file. `prev` carries the last ingested round name and
 * its file sha (for the same-round no-op exception). Pure function — IO
 * lives in ingest.ts. Rules are checked in the spec's order.
 */
export function validateRoundFile(
    fileName: string,
    raw: Buffer,
    prev: { round: string | null; fileSha256: string | null },
    totalsSumByWallet: Map<string, bigint>
): RoundFile {
    // Rule 1: parses as JSON, version 1, no keys other than those listed.
    let json: any;
    try {
        json = JSON.parse(raw.toString('utf8'));
    } catch {
        throw new FileReject('parse', 'file is not valid JSON');
    }
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
        throw new FileReject('parse', 'top level must be an object');
    }
    checkKeys(json, TOP_LEVEL_KEYS, 'file');
    if (json.version !== 1) throw new FileReject('parse', `version must be 1, got ${json.version}`);
    if (typeof json.round !== 'string') throw new FileReject('parse', 'round must be a string');
    if (typeof json.total !== 'string') throw new FileReject('parse', 'total must be a string');
    if (typeof json.count !== 'number' || !Number.isInteger(json.count) || json.count < 0) {
        throw new FileReject('parse', 'count must be a non-negative integer');
    }
    if (!Array.isArray(json.rewards)) throw new FileReject('parse', 'rewards must be an array');

    const sha = fileSha256(raw);
    const round = json.round as string;

    // Rule 2: round equals the file name, is a real calendar date, and is
    // strictly earlier than the current UTC date.
    if (`${round}.json` !== fileName) {
        throw new FileReject('round', `file name '${fileName}' does not match round '${round}'`);
    }
    if (!isValidRoundName(round)) {
        throw new FileReject('round', `round '${round}' is not a valid calendar date`);
    }
    const today = new Date().toISOString().slice(0, 10);
    if (round >= today) {
        throw new FileReject('round', `round '${round}' must be earlier than today (${today})`);
    }

    // Rule 3: later than every round already ingested. Exception: an
    // identical re-delivery of the same round (same SHA-256) is a no-op.
    if (prev.round !== null) {
        const sameFile = round === prev.round && prev.fileSha256 === sha;
        if (!sameFile && round <= prev.round) {
            throw new FileReject(
                'round',
                `round '${round}' is not later than already-ingested round '${prev.round}'`
            );
        }
    }

    // Rule 4: count equals the length of rewards.
    if (json.rewards.length !== json.count) {
        throw new FileReject('count', `count ${json.count} != rewards length ${json.rewards.length}`);
    }

    // Rules 5–7: wallets decode to 32-byte on-curve keys, amounts are
    // positive u64 decimals, no duplicate wallets.
    const seen = new Set<string>();
    const parsed: RoundReward[] = [];
    for (let i = 0; i < json.rewards.length; i++) {
        const r = json.rewards[i];
        if (typeof r !== 'object' || r === null || Array.isArray(r)) {
            throw new FileReject('schema', `rewards[${i}] must be an object`);
        }
        checkKeys(r, REWARD_KEYS, `rewards[${i}]`);
        if (typeof r.wallet !== 'string' || typeof r.amount !== 'string') {
            throw new FileReject('schema', `rewards[${i}] must have wallet and amount strings`);
        }
        let pk: PublicKey;
        try {
            pk = new PublicKey(r.wallet);
        } catch {
            throw new FileReject('wallet', `rewards[${i}].wallet '${r.wallet}' is not valid base58`);
        }
        if (pk.toBytes().length !== 32) {
            throw new FileReject('wallet', `rewards[${i}].wallet '${r.wallet}' does not decode to 32 bytes`);
        }
        if (!PublicKey.isOnCurve(pk.toBytes())) {
            throw new FileReject('wallet', `rewards[${i}].wallet '${r.wallet}' is off-curve (PDA)`);
        }
        if (!AMOUNT_RE.test(r.amount)) {
            throw new FileReject('amount', `rewards[${i}].amount '${r.amount}' is not a positive decimal integer`);
        }
        const amount = BigInt(r.amount);
        if (amount > U64_MAX) {
            throw new FileReject('amount', `rewards[${i}].amount exceeds u64`);
        }
        if (seen.has(r.wallet)) {
            throw new FileReject('duplicate', `duplicate wallet '${r.wallet}'`);
        }
        seen.add(r.wallet);
        parsed.push({ wallet: r.wallet, amount });
    }

    // Rule 8: the sum of amounts equals total. Empty day: total "0", count 0.
    if (!/^(0|[1-9][0-9]*)$/.test(json.total)) {
        throw new FileReject('total', `total '${json.total}' is not a non-negative decimal integer`);
    }
    const total = BigInt(json.total);
    if (total > U64_MAX) throw new FileReject('total', `total exceeds u64`);
    const sum = parsed.reduce((a, r) => a + r.amount, 0n);
    if (sum !== total) {
        throw new FileReject('total', `rewards sum ${sum} != declared total ${total}`);
    }

    // Rule 9: existing lifetime total plus amount fits in u64.
    for (const r of parsed) {
        const existing = totalsSumByWallet.get(r.wallet) ?? 0n;
        if (existing + r.amount > U64_MAX) {
            throw new FileReject(
                'overflow',
                `wallet '${r.wallet}' lifetime total would exceed u64 (${existing} + ${r.amount})`
            );
        }
    }

    return { round, total, rewards: parsed, sha256: sha, isEmpty: parsed.length === 0 };
}
