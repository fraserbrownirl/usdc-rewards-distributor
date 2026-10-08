import {
    Connection,
    PublicKey,
    Transaction,
    TransactionInstruction,
    SystemProgram,
} from '@solana/web3.js';
import {
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountInstruction,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

/**
 * Claim SDK — spec §14. Given a wallet and the public claims API, fetch the
 * cumulative total + Merkle proof and build the claim transaction. The
 * claimant signs and pays their own fees (D10); the wallet submits the tx.
 *
 * The claim instruction is constructed by hand (discriminator + borsh args)
 * to keep the SDK dependency-light — no IDL fetch, works in browsers.
 */

export const CONFIG_SEED = 'DistributorConfig';
export const CLAIMED_SEED = 'ClaimedRewards';
// anchor sighash for "global:claim"
const CLAIM_DISCRIMINATOR = Buffer.from([62, 198, 214, 193, 213, 159, 108, 210]);

export interface ClaimStatus {
    wallet: string;
    total: string; // cumulative lifetime total (u64 decimal)
    claimed: string;
    outstanding: string;
    proof: { root: string; round: string; hashes: string[] } | null;
}

export function configPda(programId: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from(CONFIG_SEED)], programId)[0];
}

export function claimedPda(programId: PublicKey, wallet: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
        [Buffer.from(CLAIMED_SEED), wallet.toBuffer()],
        programId
    )[0];
}

export async function fetchClaimStatus(apiBase: string, wallet: PublicKey): Promise<ClaimStatus> {
    const res = await fetch(`${apiBase}/v1/claims/${wallet.toBase58()}`);
    if (res.status === 404) throw new Error('wallet has no rewards');
    if (!res.ok) throw new Error(`claims API returned ${res.status}`);
    return (await res.json()) as ClaimStatus;
}

/** On-chain DistributorConfig fields the SDK needs (bump skipped). */
export interface OnChainConfig {
    mint: PublicKey;
    vault: PublicKey;
    shutdown: boolean;
}

export async function fetchConfig(connection: Connection, programId: PublicKey): Promise<OnChainConfig> {
    const acc = await connection.getAccountInfo(configPda(programId));
    if (!acc) throw new Error('distributor config not found on-chain');
    const d = acc.data;
    return {
        mint: new PublicKey(d.subarray(41, 73)),
        vault: new PublicKey(d.subarray(73, 105)),
        shutdown: d[169] !== 0,
    };
}

export interface BuildClaimTxArgs {
    connection: Connection;
    programId: PublicKey;
    claimant: PublicKey;
    status: ClaimStatus;
}

/**
 * Build the claim transaction: optionally create the claimant's USDC ATA,
 * then claim(total, proof). Throws if nothing is claimable or the proof is
 * not yet available (round ingested, not published).
 */
export async function buildClaimTransaction(args: BuildClaimTxArgs): Promise<Transaction> {
    const { connection, programId, claimant, status } = args;
    const outstanding = BigInt(status.outstanding);
    if (outstanding <= 0n) throw new Error('nothing to claim');
    if (!status.proof) throw new Error('proof not available yet — round not published');

    const cfg = await fetchConfig(connection, programId);
    if (cfg.shutdown) throw new Error('distributor is shut down');

    const to = getAssociatedTokenAddressSync(cfg.mint, claimant);
    const ixs: TransactionInstruction[] = [];
    const toInfo = await connection.getAccountInfo(to);
    if (!toInfo) {
        ixs.push(
            createAssociatedTokenAccountInstruction(
                claimant,
                to,
                claimant,
                cfg.mint,
                TOKEN_PROGRAM_ID,
                ASSOCIATED_TOKEN_PROGRAM_ID
            )
        );
    }

    // args: total u64 LE, proof Vec<[u8;32]> (borsh: u32 len + entries)
    const total = BigInt(status.total);
    const hashes = status.proof.hashes.map((h) => Buffer.from(h, 'hex'));
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
                { pubkey: claimedPda(programId, claimant), isSigner: false, isWritable: true },
                { pubkey: cfg.vault, isSigner: false, isWritable: true },
                { pubkey: to, isSigner: false, isWritable: true },
                { pubkey: claimant, isSigner: true, isWritable: true },
                { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data,
        })
    );

    const tx = new Transaction().add(...ixs);
    tx.feePayer = claimant;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    return tx;
}
