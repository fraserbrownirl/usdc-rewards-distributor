import {
    ComputeBudgetProgram,
    Connection,
    PublicKey,
    SystemProgram,
    Transaction,
    TransactionInstruction,
} from '@solana/web3.js';
import {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountIdempotentInstruction,
    getAssociatedTokenAddressSync,
    TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

/**
 * Claim SDK — spec §10. The wallet-side half of claiming: fetch the proof
 * from the rewards API, build the claim transaction, decode failures. The
 * claimant signs and pays their own fees; the wallet submits the tx.
 *
 * Everything is hand-rolled (discriminator + borsh) so the SDK stays
 * dependency-light and IDL-free, usable in browsers.
 */

export const CONFIG_SEED = 'DistributorConfig';
export const CLAIMED_SEED = 'ClaimedRewards';
// Anchor sighash "global:claim".
const CLAIM_DISCRIMINATOR = Buffer.from([62, 198, 214, 193, 213, 159, 108, 210]);

/** Program error codes (programs/rewards-distributor/src/error.rs). */
export const ERR_ALREADY_CLAIMED = 6000;
export const ERR_INSUFFICIENT_BALANCE = 6001;
export const ERR_INVALID_PROOF = 6002;
export const ERR_UNAUTHORIZED = 6003;
export const ERR_SAME_VALUE = 6004;
export const ERR_SHUTDOWN = 6005;

/** GET /v1/rewards/:wallet response (spec §9). */
export interface Rewards {
    wallet: string;
    root: string | null;
    round: string | null;
    /** Cumulative lifetime total in the current on-chain tree (u64 decimal). */
    total: string;
    /** Live on-chain claimed amount (u64 decimal). */
    claimed: string;
    /** total - claimed, floored at 0 (u64 decimal). */
    claimable: string;
    /** Merkle proof: hex-encoded 32-byte siblings, bottom to top. */
    proof: string[];
    program_id: string;
    mint: string;
}

export type ClaimError =
    | 'already_claimed'
    | 'insufficient_balance'
    | 'invalid_proof'
    | 'shutdown'
    | 'unknown';

export function configPda(programId: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from(CONFIG_SEED)], programId)[0];
}

export function claimedPda(programId: PublicKey, wallet: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
        [Buffer.from(CLAIMED_SEED), wallet.toBuffer()],
        programId
    )[0];
}

/** The vault: the config PDA's ATA for the mint (allowOwnerOffCurve). */
export function deriveVault(mint: PublicKey, programId: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(mint, configPda(programId), true);
}

/** Fetch the wallet's rewards + proof from the public API. */
export async function fetchRewards(apiBaseUrl: string, wallet: PublicKey | string): Promise<Rewards> {
    const w = typeof wallet === 'string' ? wallet : wallet.toBase58();
    const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/v1/rewards/${w}`);
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`rewards API ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as Rewards;
}

export interface BuildClaimTransactionArgs {
    connection: Connection;
    programId: PublicKey;
    mint: PublicKey;
    wallet: PublicKey;
    /** Cumulative total from the API (NOT the claimable delta). */
    total: bigint;
    /** Hex-encoded proof siblings from the API, bottom to top. */
    proof: string[];
    /** Compute-unit price; the price instruction is omitted when 0. */
    priorityFeeMicroLamports?: number;
}

/**
 * Build the claim transaction (legacy, wallet pays fees):
 *   [ComputeBudget limit 200k, price (only if priorityFee > 0),
 *    CreateIdempotent(wallet ATA), claim(total, proof)]
 * Throws when there is nothing to claim or no proof exists yet.
 */
export async function buildClaimTransaction(args: BuildClaimTransactionArgs): Promise<Transaction> {
    const { connection, programId, mint, wallet, total, proof } = args;
    const priorityFee = args.priorityFeeMicroLamports ?? 0;
    if (total <= 0n) throw new Error('nothing to claim');
    if (proof.length === 0) throw new Error('no proof yet — the round may not be published');

    const vault = deriveVault(mint, programId);
    const to = getAssociatedTokenAddressSync(mint, wallet);

    const ixs: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ];
    if (priorityFee > 0) {
        ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }));
    }
    ixs.push(
        createAssociatedTokenAccountIdempotentInstruction(
            wallet,
            to,
            wallet,
            mint,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
        )
    );

    // claim(total: u64, proof: Vec<[u8;32]>) — borsh: u64 LE, u32 len, entries.
    const hashes = proof.map((h) => Buffer.from(h, 'hex'));
    for (const h of hashes) {
        if (h.length !== 32) throw new Error(`proof hash must be 32 bytes, got ${h.length}`);
    }
    const data = Buffer.alloc(8 + 8 + 4 + hashes.length * 32);
    let o = 0;
    CLAIM_DISCRIMINATOR.copy(data, o); o += 8;
    data.writeBigUInt64LE(total, o); o += 8;
    data.writeUInt32LE(hashes.length, o); o += 4;
    for (const h of hashes) { h.copy(data, o); o += 32; }

    ixs.push(
        new TransactionInstruction({
            programId,
            keys: [
                { pubkey: configPda(programId), isSigner: false, isWritable: true },
                { pubkey: claimedPda(programId, wallet), isSigner: false, isWritable: true },
                { pubkey: vault, isSigner: false, isWritable: true }, // from
                { pubkey: to, isSigner: false, isWritable: true },
                { pubkey: wallet, isSigner: true, isWritable: true }, // claimant
                { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data,
        })
    );

    const tx = new Transaction().add(...ixs);
    tx.feePayer = wallet;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    return tx;
}

/** Rent needed before a first claim: claim record (32 B) + USDC ATA (165 B). */
export async function claimRentLamports(connection: Connection): Promise<bigint> {
    const record = await connection.getMinimumBalanceForRentExemption(32);
    const ata = await connection.getMinimumBalanceForRentExemption(165);
    return BigInt(record + ata);
}

/**
 * Map a send/confirm failure to a claim error. Handles web3.js
 * SendTransactionError logs ("custom program error: 0x1772") and any
 * JSON-RPC error object embedding the numeric code.
 */
export function parseClaimError(err: unknown): ClaimError {
    const haystacks: string[] = [];
    if (err instanceof Error) {
        haystacks.push(err.message);
        const logs = (err as { logs?: unknown }).logs;
        if (Array.isArray(logs)) haystacks.push(logs.join('\n'));
    }
    haystacks.push(JSON.stringify(err ?? ''));
    const text = haystacks.join('\n');

    const codes: [number, ClaimError][] = [
        [ERR_ALREADY_CLAIMED, 'already_claimed'],
        [ERR_INSUFFICIENT_BALANCE, 'insufficient_balance'],
        [ERR_INVALID_PROOF, 'invalid_proof'],
        [ERR_SHUTDOWN, 'shutdown'],
    ];
    for (const [code, name] of codes) {
        const hex = `0x${code.toString(16)}`;
        if (
            text.includes(`custom program error: ${hex}`) ||
            text.includes(`"InstructionError":[0,{"Custom":${code}}]`) ||
            text.includes(`"Custom":${code}`) ||
            text.includes(`Error Code: ${code}`) ||
            text.includes(`custom program error: ${code}`)
        ) {
            return name;
        }
    }
    return 'unknown';
}

/**
 * Claim with one InvalidProof retry (spec §10): on invalid_proof, wait,
 * refetch the proof (the root may have rotated mid-claim), rebuild, and try
 * once more. `signAndSend` is supplied by the caller (wallet adapter).
 */
export async function claimWithRetry(opts: {
    connection: Connection;
    apiBaseUrl: string;
    programId: PublicKey;
    mint: PublicKey;
    wallet: PublicKey;
    priorityFeeMicroLamports?: number;
    signAndSend: (tx: Transaction) => Promise<string>;
    sleepMs?: number;
}): Promise<{ signature: string; retried: boolean }> {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (let attempt = 0; attempt < 2; attempt++) {
        const rewards = await fetchRewards(opts.apiBaseUrl, opts.wallet);
        const tx = await buildClaimTransaction({
            connection: opts.connection,
            programId: opts.programId,
            mint: opts.mint,
            wallet: opts.wallet,
            total: BigInt(rewards.total),
            proof: rewards.proof,
            priorityFeeMicroLamports: opts.priorityFeeMicroLamports,
        });
        try {
            const signature = await opts.signAndSend(tx);
            return { signature, retried: attempt > 0 };
        } catch (e) {
            const kind = parseClaimError(e);
            if (kind === 'invalid_proof' && attempt === 0) {
                await sleep(opts.sleepMs ?? 3_000);
                continue; // refetch + rebuild once
            }
            throw Object.assign(e instanceof Error ? e : new Error(String(e)), { claimError: kind });
        }
    }
    throw new Error('unreachable');
}
