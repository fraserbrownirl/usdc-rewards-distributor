import {
    ComputeBudgetProgram,
    Connection,
    Keypair,
    PublicKey,
    Transaction,
    TransactionInstruction,
} from '@solana/web3.js';
import {
    createTransferCheckedInstruction,
    getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { PoolClient } from 'pg';
import bs58 from 'bs58';
import { Db } from './db';
import { JobConfig } from './config';
import { Alerter } from './alerts';

/**
 * On-chain access + the publish transaction (spec §8 step 9).
 *
 * ONE atomic transaction, signed by the operator:
 *   [ComputeBudget limit 100_000, ComputeBudget price PRIORITY_FEE_MICROLAMPORTS,
 *    TransferChecked(round total, 6 decimals, operator ATA -> vault),
 *    update_root(new_root)]
 * The signature and lastValidBlockHeight are stored on the round BEFORE
 * sending. Confirm to finalized; if the block height passes
 * lastValidBlockHeight unconfirmed, the caller returns to its
 * "already landed?" check before signing again.
 */

export const CONFIG_SEED = 'DistributorConfig';
export const CLAIMED_SEED = 'ClaimedRewards';
export const ZERO_ROOT_HEX = '0'.repeat(64);

// Anchor account discriminator of ClaimedRewards (sha256("account:ClaimedRewards")[..8]).
export const CLAIMED_DISCRIMINATOR = Buffer.from([105, 246, 152, 121, 249, 99, 139, 216]);
// Anchor sighash "global:update_root".
const UPDATE_ROOT_DISCRIMINATOR = Buffer.from([58, 195, 57, 246, 116, 198, 170, 138]);

export function configPda(programId: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from(CONFIG_SEED)], programId)[0];
}

export function claimedPda(programId: PublicKey, wallet: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
        [Buffer.from(CLAIMED_SEED), wallet.toBuffer()],
        programId
    )[0];
}

export interface OnChainConfig {
    root: Uint8Array;
    mint: PublicKey;
    vault: PublicKey; // token_vault — the ATA claims are paid from
    admin: PublicKey;
    updater: PublicKey;
    shutdown: boolean;
}

export function parseConfigAccount(data: Buffer): OnChainConfig {
    // Layout (state/distributor_config.rs): 8-byte discriminator, bump u8,
    // root [u8;32], mint, token_vault, admin, updater, shutdown bool.
    return {
        root: data.subarray(9, 41),
        mint: new PublicKey(data.subarray(41, 73)),
        vault: new PublicKey(data.subarray(73, 105)),
        admin: new PublicKey(data.subarray(105, 137)),
        updater: new PublicKey(data.subarray(137, 169)),
        shutdown: data[169] !== 0,
    };
}

export async function fetchOnChainConfig(
    connection: Connection,
    programId: PublicKey
): Promise<OnChainConfig> {
    const acc = await connection.getAccountInfo(configPda(programId));
    if (!acc) throw new Error('on-chain config account not found — program not initialized?');
    return parseConfigAccount(acc.data);
}

/** The vault: the config PDA's associated token account for the mint. */
export function deriveVault(mint: PublicKey, programId: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(mint, configPda(programId), true);
}

/**
 * A wallet's cumulative claimed amount, or 0n if no record. On-chain layout
 * (programs/.../state/claimed_rewards.rs, 32 bytes):
 *   8-byte discriminator | bump u8 @8 | claimed u64 LE @9 | padding to 32.
 */
export function parseClaimedAmount(data: Buffer | null): bigint {
    if (!data || data.length < 17) return 0n;
    return data.readBigUInt64LE(9);
}

export async function fetchClaimed(
    connection: Connection,
    programId: PublicKey,
    wallet: PublicKey
): Promise<bigint> {
    const acc = await connection.getAccountInfo(claimedPda(programId, wallet), 'confirmed');
    return parseClaimedAmount(acc?.data ?? null);
}

export interface PublishOutcome {
    /** confirmed: tx finalized (or had already landed). retry: blockhash
     *  expired — caller re-checks the on-chain root before signing again. */
    outcome: 'confirmed' | 'retry';
    signature: string;
    lastValidBlockHeight: number;
    slot: number;
}

/**
 * Send the atomic publish transaction for a round. Throws (after a critical
 * alert) when the transaction fails and did NOT land; returns 'retry' when
 * confirmation timed out without the tx landing.
 */
export async function publishRound(
    db: Db,
    cfg: JobConfig,
    operator: Keypair,
    alerter: Alerter,
    client: PoolClient,
    round: string,
    roundTotal: bigint,
    newRoot: Uint8Array,
    newRootHex: string
): Promise<PublishOutcome> {
    const connection = new Connection(cfg.rpcUrl, 'confirmed');
    const programId = new PublicKey(cfg.programId);
    const mint = new PublicKey(cfg.usdcMint);
    const operatorAta = getAssociatedTokenAddressSync(mint, operator.publicKey);

    // update_root(new_root) — discriminator + 32-byte root, accounts resolved
    // the way RewardsDistributorWrapper.updateRoot does (config PDA + updater).
    const data = Buffer.alloc(8 + 32);
    UPDATE_ROOT_DISCRIMINATOR.copy(data, 0);
    Buffer.from(newRoot).copy(data, 8);
    const updateRootIx = new TransactionInstruction({
        programId,
        keys: [
            { pubkey: configPda(programId), isSigner: false, isWritable: true },
            { pubkey: operator.publicKey, isSigner: true, isWritable: false },
        ],
        data,
    });

    const transferIx = createTransferCheckedInstruction(
        operatorAta,
        mint,
        deriveVault(mint, programId),
        operator.publicKey,
        roundTotal,
        6 // USDC decimals
    );

    const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cfg.priorityFeeMicrolamports }),
        transferIx,
        updateRootIx
    );
    tx.feePayer = operator.publicKey;

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
    tx.recentBlockhash = blockhash;
    tx.sign(operator);
    // web3.js ≥1.87 populates tx.signature with the raw 64 bytes; every RPC
    // call below wants the base58 encoding.
    const signature = bs58.encode(tx.signature!);

    // Spec §8 step 9: store the signature + lastValidBlockHeight BEFORE sending.
    await db.recordPublishAttempt(client, round, signature, lastValidBlockHeight);

    try {
        await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
        await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'finalized');
    } catch (e) {
        // Timeout or send failure: the tx may still have landed. Re-read the
        // on-chain root before concluding anything (spec §8).
        const after = await fetchOnChainConfig(connection, programId).catch(() => null);
        if (after && Buffer.from(after.root).equals(Buffer.from(newRoot))) {
            const sig = await connection.getSignatureStatus(signature).catch(() => null);
            return { outcome: 'confirmed', signature, lastValidBlockHeight, slot: sig?.value?.slot ?? 0 };
        }
        const height = await connection.getBlockHeight().catch(() => 0);
        if (height > lastValidBlockHeight) {
            // Expired unconfirmed: safe to go back to "already landed?".
            return { outcome: 'retry', signature, lastValidBlockHeight, slot: 0 };
        }
        await alerter.error('publish_failed', `publish transaction failed for round ${round}`, {
            round,
            error: (e as Error).message,
            signature,
        });
        throw e;
    }

    const sig = await connection.getSignatureStatus(signature).catch(() => null);
    return { outcome: 'confirmed', signature, lastValidBlockHeight, slot: sig?.value?.slot ?? 0 };
}
