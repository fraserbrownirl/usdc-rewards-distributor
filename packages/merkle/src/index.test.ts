import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import {
    MAX_PROOF_LENGTH,
    buildTree,
    hashLeaf,
    proofFromBytes,
    proofToBytes,
    verifyProof,
} from './index';

// Fixture from the upstream test suite (packages/tests/src/shared/consts.ts):
// leaf for ELIGIBLE_USER_PK @ total 1_234_567_890 inside a larger tree whose
// root and 9-hash proof are precalculated. We reproduce a tree with the same
// construction rules and verify the proof path semantics independently.

// NB: the upstream ELIGIBLE_USER_PK const is a 64-byte secret key; the
// merkle leaf hashes the *public* key, which is its last 32 bytes.
const ELIGIBLE_USER_SK = Buffer.from([
    36, 53, 134, 213, 157, 174, 255, 148, 233, 193, 192, 57, 214, 33, 141, 106, 139, 235, 61, 246, 35,
    246, 98, 203, 168, 197, 253, 157, 113, 225, 63, 82, 192, 216, 235, 12, 179, 64, 244, 46, 91,
    199, 37, 240, 234, 167, 229, 5, 6, 175, 196, 124, 170, 195, 129, 149, 200, 72, 180, 117, 201,
    64, 29, 182,
]);
const ELIGIBLE_USER_PK = ELIGIBLE_USER_SK.subarray(32);

// Upstream fixture: precalculated root + 9-hash proof for
// (ELIGIBLE_USER_PK, 1_234_567_890) from packages/tests/src/shared/consts.ts.
// Folding the proof with our pair rule must reproduce the root exactly —
// this is the byte-for-byte conformance check against the on-chain verifier.
const MERKLE_ROOT_FIXTURE = Buffer.from(
    'c0a879150e723527fea71b5b0b7ffd6ac61702066b91a8882b5d29581d937eb7',
    'hex'
);
const MERKLE_PROOF_FIXTURE = [
    '5d5ac08387c6c61821fcb3baec63a06294acde9f934dca2ff90020d87141738e',
    '6a4023b88909ceb032e0b12d6767827e999828fff97db50bd6f7f78da957aea9',
    'bdc37272b993e8179b0e119e536fdd2b80eae9b35d132e8b4e7cf1476f70bc10',
    '7d23de928816d048c087708be5dbeb7e2e2c4a8d5c05359fd0f3bd05b930e2b6',
    '850332ecea6a0d40bcfe0ac1d53979794777791cce708fe5e2edce71c70e3c54',
    'fe0615b5e3c96a65d3e9bd81e6aeec8ec67d0287162bb072d0288888d122e36e',
    'b8276bf2167f5661fe837d3e23c5c522519e8fc6694c48123c1507791257b916',
    '425fe77edcf2816bd3e98f37c98a558201c66d8b661a26ce731d34c6289e52f8',
    '9716d96af0bc09e643d1871cd4a1078162ffde424e46ec6de241a68a7c8b692c',
].map((h) => Buffer.from(h, 'hex'));

describe('upstream fixture conformance', () => {
    it('folds the consts.ts proof to the precalculated root', () => {
        expect(
            verifyProof(ELIGIBLE_USER_PK, 1234567890n, MERKLE_PROOF_FIXTURE, MERKLE_ROOT_FIXTURE)
        ).toBe(true);
    });

    it('rejects the fixture with a wrong amount', () => {
        expect(
            verifyProof(ELIGIBLE_USER_PK, 1234567891n, MERKLE_PROOF_FIXTURE, MERKLE_ROOT_FIXTURE)
        ).toBe(false);
    });
});

describe('hashLeaf', () => {
    it('matches the upstream double-sha256 leaf construction', () => {
        // sha256(sha256(pk || u64be(1234567890))) — computed independently
        const { createHash } = require('crypto');
        const amount = Buffer.alloc(8);
        amount.writeBigUInt64BE(1234567890n);
        const inner = createHash('sha256').update(Buffer.concat([ELIGIBLE_USER_PK, amount])).digest();
        const expected = createHash('sha256').update(inner).digest('hex');
        expect(hashLeaf(ELIGIBLE_USER_PK, 1234567890n).toString('hex')).toBe(expected);
    });

    it('rejects wrong wallet length', () => {
        expect(() => hashLeaf(Buffer.alloc(31), 1n)).toThrow(/32 bytes/);
    });

    it('rejects out-of-range totals', () => {
        expect(() => hashLeaf(ELIGIBLE_USER_PK, -1n)).toThrow(/u64/);
        expect(() => hashLeaf(ELIGIBLE_USER_PK, 2n ** 64n)).toThrow(/u64/);
        expect(hashLeaf(ELIGIBLE_USER_PK, 2n ** 64n - 1n)).toHaveLength(32);
    });
});

describe('buildTree', () => {
    it('single entry: root = leaf, empty proof', () => {
        const tree = buildTree([{ wallet: ELIGIBLE_USER_PK, total: 1234567890n }]);
        expect(tree.root.equals(hashLeaf(ELIGIBLE_USER_PK, 1234567890n))).toBe(true);
        expect(tree.proofs.get(ELIGIBLE_USER_PK.toString('hex'))).toEqual([]);
        expect(verifyProof(ELIGIBLE_USER_PK, 1234567890n, [], tree.root)).toBe(true);
    });

    it('rejects empty and duplicate entry sets', () => {
        expect(() => buildTree([])).toThrow(/empty/);
        expect(() =>
            buildTree([
                { wallet: ELIGIBLE_USER_PK, total: 1n },
                { wallet: ELIGIBLE_USER_PK, total: 2n },
            ])
        ).toThrow(/duplicate/);
    });

    it('every generated proof verifies against the root (randomized)', () => {
        const sizes = [2, 3, 4, 5, 7, 8, 9, 16, 17, 33, 64, 100, 257];
        for (const n of sizes) {
            const entries = Array.from({ length: n }, (_, i) => ({
                wallet: Buffer.from(Keypair.generate().publicKey.toBytes()),
                total: BigInt(1 + i * 1_000_000),
            }));
            const tree = buildTree(entries);
            for (const e of entries) {
                const proof = tree.proofs.get(e.wallet.toString('hex'))!;
                expect(proof.length).toBeLessThanOrEqual(MAX_PROOF_LENGTH);
                expect(verifyProof(e.wallet, e.total, proof, tree.root)).toBe(true);
                // Wrong total must fail.
                expect(verifyProof(e.wallet, e.total + 1n, proof, tree.root)).toBe(false);
            }
        }
    });

    it('sorting by wallet bytes makes the tree order-insensitive to input order', () => {
        const entries = Array.from({ length: 32 }, (_, i) => ({
            wallet: Buffer.from(Keypair.generate().publicKey.toBytes()),
            total: BigInt(1000 + i),
        }));
        const shuffled = entries.slice().reverse();
        expect(buildTree(entries).root.equals(buildTree(shuffled).root)).toBe(true);
    });

    it('proof byte round-trip', () => {
        const entries = Array.from({ length: 10 }, (_, i) => ({
            wallet: Buffer.from(Keypair.generate().publicKey.toBytes()),
            total: BigInt(5 + i),
        }));
        const tree = buildTree(entries);
        for (const e of entries) {
            const proof = tree.proofs.get(e.wallet.toString('hex'))!;
            const round = proofFromBytes(proofToBytes(proof));
            expect(round.length).toBe(proof.length);
            round.forEach((h, i) => expect(h.equals(proof[i])).toBe(true));
            expect(verifyProof(e.wallet, e.total, round, tree.root)).toBe(true);
        }
    });

    it('10k-wallet tree proofs stay within the 20-hash cap', () => {
        const entries = Array.from({ length: 10_000 }, (_, i) => ({
            wallet: Buffer.from(Keypair.generate().publicKey.toBytes()),
            total: BigInt(i + 1),
        }));
        const tree = buildTree(entries);
        for (const [, proof] of tree.proofs) {
            expect(proof.length).toBeLessThanOrEqual(MAX_PROOF_LENGTH);
        }
    });
});
