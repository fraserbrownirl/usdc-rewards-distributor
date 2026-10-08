import { createHash } from 'crypto';

/**
 * Merkle tree construction for the POD Miner rewards distributor.
 *
 * Byte-for-byte compatible with the on-chain verifier in
 * programs/rewards-distributor/src/instructions/claim.rs:
 *
 *   leaf   = SHA256(SHA256(wallet_bytes_32 || total_u64_big_endian))
 *   parent = SHA256(lo || hi)   where lo/hi are the two child hashes in
 *            unsigned lexicographic (byte-wise) order
 *
 * Entries are sorted by raw wallet bytes. An odd node at any level is
 * promoted unchanged. A single-entry tree has root = leaf and an empty
 * proof. The empty set is invalid (never posted on chain).
 */

export const HASH_BYTES = 32;
export const MAX_PROOF_LENGTH = 20;

export interface TreeEntry {
    /** Raw 32-byte wallet public key. */
    wallet: Buffer;
    /** Cumulative lifetime total in token base units (u64). */
    total: bigint;
}

export interface MerkleTree {
    root: Buffer;
    /** Leaves keyed by wallet hex, in sorted order. */
    entries: TreeEntry[];
    /** Proof per wallet hex (ordered sibling list, rootward). */
    proofs: Map<string, Buffer[]>;
}

function sha256(data: Buffer): Buffer {
    return createHash('sha256').update(data).digest();
}

export function hashLeaf(wallet: Buffer, total: bigint): Buffer {
    if (wallet.length !== HASH_BYTES) {
        throw new Error(`wallet must be ${HASH_BYTES} bytes, got ${wallet.length}`);
    }
    if (total < 0n || total > 0xffffffffffffffffn) {
        throw new Error(`total out of u64 range: ${total}`);
    }
    const amount = Buffer.alloc(8);
    amount.writeBigUInt64BE(total);
    return sha256(sha256(Buffer.concat([wallet, amount])));
}

/** Unsigned lexicographic byte comparison. */
export function compareHashes(a: Buffer, b: Buffer): number {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return a.length - b.length;
}

export function hashPair(a: Buffer, b: Buffer): Buffer {
    return compareHashes(a, b) <= 0 ? sha256(Buffer.concat([a, b])) : sha256(Buffer.concat([b, a]));
}

/**
 * Build the tree. Entries are deduplicated by wallet (last write wins is
 * NOT allowed — duplicates throw, callers must aggregate first).
 */
export function buildTree(entries: TreeEntry[]): MerkleTree {
    if (entries.length === 0) {
        throw new Error('cannot build a tree from an empty entry set');
    }
    const seen = new Set<string>();
    const sorted = entries
        .map((e) => ({ wallet: Buffer.from(e.wallet), total: BigInt(e.total) }))
        .sort((a, b) => compareHashes(a.wallet, b.wallet));
    for (const e of sorted) {
        const key = e.wallet.toString('hex');
        if (seen.has(key)) throw new Error(`duplicate wallet in entry set: ${key}`);
        seen.add(key);
    }

    const leaves = sorted.map((e) => hashLeaf(e.wallet, e.total));

    // Build levels; track each leaf's index through the levels to collect siblings.
    const proofs: Map<string, Buffer[]> = new Map(sorted.map((e) => [e.wallet.toString('hex'), []]));
    let level = leaves.slice();
    let positions = sorted.map((_, i) => i);

    while (level.length > 1) {
        const next: Buffer[] = [];
        const nextPositions: number[] = [];
        for (let i = 0; i < level.length; i += 2) {
            if (i + 1 < level.length) {
                next.push(hashPair(level[i], level[i + 1]));
                // The leaf tracked at positions[k] sits at level index i or i+1;
                // its sibling is the other one.
                for (let k = 0; k < positions.length; k++) {
                    if (positions[k] === i || positions[k] === i + 1) {
                        const sibling = positions[k] === i ? i + 1 : i;
                        proofs.get(sorted[k].wallet.toString('hex'))!.push(level[sibling]);
                        positions[k] = next.length - 1;
                    }
                }
            } else {
                // Odd node promoted unchanged; no sibling at this level.
                next.push(level[i]);
                for (let k = 0; k < positions.length; k++) {
                    if (positions[k] === i) {
                        positions[k] = next.length - 1;
                    }
                }
            }
        }
        level = next;
    }

    const root = level[0];
    for (const [, proof] of proofs) {
        if (proof.length > MAX_PROOF_LENGTH) {
            throw new Error(`proof length ${proof.length} exceeds max ${MAX_PROOF_LENGTH}`);
        }
    }
    return { root, entries: sorted, proofs };
}

/** Verify a proof against a root, mirroring the on-chain fold. */
export function verifyProof(wallet: Buffer, total: bigint, proof: Buffer[], root: Buffer): boolean {
    const leaf = hashLeaf(wallet, total);
    const acc = proof.reduce((acc, sibling) => hashPair(acc, sibling), leaf);
    return acc.equals(root);
}

/** Serialize a proof to concatenated 32-byte siblings (ledger storage). */
export function proofToBytes(proof: Buffer[]): Buffer {
    return Buffer.concat(proof);
}

/** Inverse of proofToBytes. */
export function proofFromBytes(data: Buffer): Buffer[] {
    if (data.length % HASH_BYTES !== 0) {
        throw new Error(`proof blob length ${data.length} is not a multiple of ${HASH_BYTES}`);
    }
    const out: Buffer[] = [];
    for (let i = 0; i < data.length; i += HASH_BYTES) {
        out.push(data.subarray(i, i + HASH_BYTES));
    }
    return out;
}

/** Hex helpers (64-char lowercase). */
export function toHex(b: Buffer): string {
    return b.toString('hex');
}
export function fromHex(s: string): Buffer {
    if (!/^[0-9a-f]{64}$/.test(s)) throw new Error(`invalid hash hex: ${s}`);
    return Buffer.from(s, 'hex');
}
