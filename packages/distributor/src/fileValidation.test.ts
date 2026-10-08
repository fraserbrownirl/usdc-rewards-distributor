import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { validateRoundFile, FileReject, isValidRoundName } from './fileValidation';

function wallet(): string {
    return Keypair.generate().publicKey.toBase58();
}

function file(overrides: Record<string, unknown> = {}, rewards?: { wallet: string; amount: string }[]): Buffer {
    const rs = rewards ?? [{ wallet: wallet(), amount: '100' }, { wallet: wallet(), amount: '50' }];
    const total = rs.reduce((a, r) => a + BigInt(r.amount), 0n).toString();
    return Buffer.from(
        JSON.stringify({ version: 1, round: '2026-10-07', total, count: rs.length, rewards: rs, ...overrides })
    );
}

const NO_PREV = { round: null, fileSha256: null };
const NO_TOTALS = new Map<string, bigint>();

describe('isValidRoundName', () => {
    it('accepts real dates, rejects impossible ones', () => {
        expect(isValidRoundName('2026-02-28')).toBe(true);
        expect(isValidRoundName('2024-02-29')).toBe(true); // leap
        expect(isValidRoundName('2026-02-29')).toBe(false);
        expect(isValidRoundName('2026-13-01')).toBe(false);
        expect(isValidRoundName('2026-1-1')).toBe(false);
    });
});

describe('validateRoundFile', () => {
    it('accepts a well-formed file', () => {
        const parsed = validateRoundFile('2026-10-07.json', file(), NO_PREV, NO_TOTALS);
        expect(parsed.round).toBe('2026-10-07');
        expect(parsed.total).toBe(150n);
        expect(parsed.rewards).toHaveLength(2);
    });

    it('rejects non-JSON and wrong schema', () => {
        expect(() => validateRoundFile('2026-10-07.json', Buffer.from('nope'), NO_PREV, NO_TOTALS)).toThrow(FileReject);
        expect(() => validateRoundFile('2026-10-07.json', Buffer.from('[1]'), NO_PREV, NO_TOTALS)).toThrow(FileReject);
        expect(() => validateRoundFile('2026-10-07.json', file({ version: 2 }), NO_PREV, NO_TOTALS)).toThrow(/version/);
        expect(() => validateRoundFile('2026-10-07.json', file({ count: 1.5 }), NO_PREV, NO_TOTALS)).toThrow(/count/);
    });

    it('rejects filename/round mismatch and future rounds', () => {
        expect(() => validateRoundFile('2026-10-08.json', file(), NO_PREV, NO_TOTALS)).toThrow(/does not match/);
        const future = new Date(Date.now() + 86400_000 * 2).toISOString().slice(0, 10);
        expect(() =>
            validateRoundFile(`${future}.json`, file({ round: future }), NO_PREV, NO_TOTALS)
        ).toThrow(/future/);
    });

    it('enforces monotonic rounds with same-sha exception', () => {
        const raw = file();
        const prev = { round: '2026-10-07', fileSha256: 'deadbeef' };
        expect(() => validateRoundFile('2026-10-07.json', raw, prev, NO_TOTALS)).toThrow(/not after/);
        expect(() => validateRoundFile('2026-10-06.json', file({ round: '2026-10-06' }), prev, NO_TOTALS)).toThrow(/not after/);
        // identical re-delivery passes validation (caller no-ops on it)
        const sha = require('crypto').createHash('sha256').update(raw).digest('hex');
        const parsed = validateRoundFile('2026-10-07.json', raw, { round: '2026-10-07', fileSha256: sha }, NO_TOTALS);
        expect(parsed.round).toBe('2026-10-07');
    });

    it('rejects count mismatch, empty round, duplicate wallet', () => {
        expect(() => validateRoundFile('2026-10-07.json', file({ count: 99 }), NO_PREV, NO_TOTALS)).toThrow(/count/);
        expect(() =>
            validateRoundFile('2026-10-07.json', file({ count: 0, total: '0' }, []), NO_PREV, NO_TOTALS)
        ).toThrow(/zero/);
        const w = wallet();
        expect(() =>
            validateRoundFile('2026-10-07.json', file({}, [{ wallet: w, amount: '1' }, { wallet: w, amount: '2' }]), NO_PREV, NO_TOTALS)
        ).toThrow(/duplicate/);
    });

    it('rejects bad wallets: non-base58 and off-curve PDA', () => {
        expect(() =>
            validateRoundFile('2026-10-07.json', file({}, [{ wallet: 'not-base58!!!', amount: '1' }]), NO_PREV, NO_TOTALS)
        ).toThrow(/base58/);
        // A PDA: valid base58, off-curve. findProgramAddress guarantees off-curve.
        const [pda] = PublicKey.findProgramAddressSync([Buffer.from('x')], Keypair.generate().publicKey);
        expect(() =>
            validateRoundFile('2026-10-07.json', file({}, [{ wallet: pda.toBase58(), amount: '1' }]), NO_PREV, NO_TOTALS)
        ).toThrow(/off-curve/);
    });

    it('rejects bad amounts and sum mismatch', () => {
        expect(() =>
            validateRoundFile('2026-10-07.json', file({ total: '0', count: 1 }, [{ wallet: wallet(), amount: '0' }]), NO_PREV, NO_TOTALS)
        ).toThrow(/amount/);
        expect(() =>
            validateRoundFile('2026-10-07.json', file({ total: '999' }), NO_PREV, NO_TOTALS)
        ).toThrow(/sum/);
        const big = (2n ** 64n).toString();
        expect(() =>
            validateRoundFile('2026-10-07.json', file({ total: big, count: 1 }, [{ wallet: wallet(), amount: big }]), NO_PREV, NO_TOTALS)
        ).toThrow(/u64/);
    });

    it('rejects lifetime u64 overflow against existing totals', () => {
        const w = wallet();
        const totals = new Map([[w, 2n ** 64n - 10n]]);
        expect(() =>
            validateRoundFile('2026-10-07.json', file({ total: '11', count: 1 }, [{ wallet: w, amount: '11' }]), NO_PREV, totals)
        ).toThrow(/exceed u64/);
    });
});
