import {
    ComputeBudgetProgram,
    Connection,
    Keypair,
    PublicKey,
    Transaction,
} from '@solana/web3.js';
import {
    createTransferCheckedInstruction,
    getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { Program, AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Db } from './db';
import { Config } from './config';
import { Alerter } from './alerts';
import { buildTree, proofToBytes, toHex } from '@podminer/merkle';
import { PoolClient } from 'pg';

/**
 * Publish — spec §9. For the pending `ingested` round: build the cumulative
 * Merkle tree from the totals table, then submit ONE atomic transaction:
 *   [ComputeBudget limit, ComputeBudget price, TransferChecked(round total),
 *    update_root(new_root)]
 * Confirm to finalized; on timeout, re-read the on-chain root before
 * concluding anything. Then mark the round published and prune old trees.
 */

export const CONFIG_SEED = 'DistributorConfig';

export function configPda(programId: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from(CONFIG_SEED)], programId)[0];
}

export interface OnChainConfig {
    root: Uint8Array;
    mint: PublicKey;
    vault: PublicKey; // token_vault — the ATA claims are paid from
    admin: PublicKey;
    updater: PublicKey;
    shutdown: boolean;
}

export async function fetchOnChainRoot(
    connection: Connection,
    programId: PublicKey
): Promise<OnChainConfig> {
    // Layout (state/distributor_config.rs): 8-byte discriminator, bump u8,
    // root [u8;32], mint, token_vault, admin, updater, shutdown bool.
    const acc = await connection.getAccountInfo(configPda(programId));
    if (!acc) throw new Error('on-chain config account not found — program not initialized?');
    const d = acc.data;
    return {
        root: d.subarray(9, 41),
        mint: new PublicKey(d.subarray(41, 73)),
        vault: new PublicKey(d.subarray(73, 105)),
        admin: new PublicKey(d.subarray(105, 137)),
        updater: new PublicKey(d.subarray(137, 169)),
        shutdown: d[169] !== 0,
    };
}

export interface PublishResult {
    action: 'published' | 'already_current' | 'none';
    round?: string;
    root?: string;
    signature?: string;
    detail?: string;
}

export async function publishPendingRound(
    db: Db,
    cfg: Config,
    operator: Keypair,
    alerter: Alerter,
    client: PoolClient
): Promise<PublishResult> {
    const pending = await db.pendingIngestedRound(client);
    if (!pending) return { action: 'none' };

    const connection = new Connection(cfg.rpcUrl, 'confirmed');
    const programId = new PublicKey(cfg.programId);
    const mint = new PublicKey(cfg.usdcMint);

    // Root sanity: on-chain root must match the root of the newest tree that
    // is NOT the pending round's (i.e. the last published state), or the
    // zero-ish initial root on first publish.
    const onchain = await fetchOnChainRoot(connection, programId);
    if (onchain.shutdown) {
        await alerter.critical('publish_failed', 'on-chain config is shut down', { round: pending.round });
        throw new Error('program is shut down');
    }
    if (!onchain.updater.equals(operator.publicKey)) {
        await alerter.critical('publish_failed', 'operator is not the on-chain updater', {
            round: pending.round,
            updater: onchain.updater.toBase58(),
        });
        throw new Error(`operator ${operator.publicKey.toBase58()} != on-chain updater ${onchain.updater.toBase58()}`);
    }

    // Build the cumulative tree from totals (all rounds through the pending one).
    const totals = await db.allTotals(client);
    const entries = [...totals.entries()].map(([wallet, total]) => ({
        wallet: Buffer.from(new PublicKey(wallet).toBytes()),
        total,
    }));
    const tree = buildTree(entries);
    const newRootHex = toHex(tree.root);

    if (Buffer.from(onchain.root).equals(tree.root)) {
        // Already published (e.g. previous run's tx landed but the mark failed).
        await db.markPublished(client, pending.round, pending.publish_signature ?? 'recovered', pending.publish_slot ?? 0, pending.publish_last_valid_block_height ?? 0);
        return { action: 'already_current', round: pending.round, root: newRootHex };
    }

    // Funding check: operator ATA must hold >= round total.
    const operatorAta = getAssociatedTokenAddressSync(mint, operator.publicKey);
    const bal = await connection.getTokenAccountBalance(operatorAta).catch(() => null);
    if (!bal || BigInt(bal.value.amount) < BigInt(pending.total)) {
        await alerter.critical('publish_failed', 'operator USDC balance below round total', {
            round: pending.round,
            need: pending.total,
            have: bal?.value.amount ?? '0',
        });
        throw new Error(`insufficient operator USDC: have ${bal?.value.amount ?? 0}, need ${pending.total}`);
    }
    const sol = await connection.getBalance(operator.publicKey);
    if (sol < cfg.minOperatorSolLamports) {
        await alerter.warning('low_operator_sol', 'operator SOL below threshold', { lamports: sol });
    }

    // Persist the tree + proofs BEFORE publishing (spec §10: proofs must be
    // servable the moment the root is on-chain; if the tx then fails, the
    // tree row is simply superseded on retry by the same root).
    const proofs = new Map<string, Buffer>();
    for (const [wallet] of totals) {
        const key = Buffer.from(new PublicKey(wallet).toBytes()).toString('hex');
        const p = tree.proofs.get(key);
        if (!p) throw new Error(`no proof built for wallet ${wallet}`);
        proofs.set(wallet, Buffer.from(proofToBytes(p)));
    }
    await db.storeTree(client, newRootHex, pending.round, proofs);

    // Build the atomic transaction. IDL bundled from the anchor build
    // (target/idl), so no on-chain IDL account is needed.
    const idlPath = process.env.REWARDS_DISTRIBUTOR_IDL_PATH
        ?? join(__dirname, '..', '..', '..', 'target', 'idl', 'rewards_distributor.json');
    const idl = JSON.parse(readFileSync(idlPath, 'utf8'));
    const provider = new AnchorProvider(connection, new Wallet(operator), { commitment: 'confirmed' });
    const program = new Program(idl, provider);

    const updateRootIx = await (program.methods as any)
        .updateRoot(Array.from(tree.root))
        .accounts({
            config: configPda(programId),
            updater: operator.publicKey,
        })
        .instruction();

    const transferIx = createTransferCheckedInstruction(
        operatorAta,
        mint,
        onchain.vault,
        operator.publicKey,
        BigInt(pending.total),
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

    let signature: string;
    try {
        signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
        await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'finalized');
    } catch (e) {
        // Timeout or send failure: the tx may still have landed. Re-check the
        // on-chain root before declaring failure (spec §9).
        const after = await fetchOnChainRoot(connection, programId).catch(() => null);
        if (after && Buffer.from(after.root).equals(tree.root)) {
            const sigs = await connection.getSignaturesForAddress(configPda(programId), { limit: 1 });
            signature = sigs[0]?.signature ?? 'unknown';
        } else {
            await alerter.critical('publish_failed', 'publish transaction failed', {
                round: pending.round,
                error: (e as Error).message,
            });
            throw e;
        }
    }

    await db.markPublished(client, pending.round, signature, 0, lastValidBlockHeight);
    await db.pruneTrees(client, newRootHex);
    return { action: 'published', round: pending.round, root: newRootHex, signature };
}
