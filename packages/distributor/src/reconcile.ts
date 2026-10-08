import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { PoolClient } from 'pg';
import { Db } from './db';
import { JobConfig } from './config';
import { Alerter } from './alerts';
import {
    CLAIMED_DISCRIMINATOR,
    deriveVault,
    fetchOnChainConfig,
    parseClaimedAmount,
    ZERO_ROOT_HEX,
} from './publish';

/**
 * Reconciliation — spec §8 step 11. Runs at the end of every job and on
 * demand (`distributor reconcile`).
 *
 *   B = on-chain vault balance
 *   C = sum of every ClaimedRewards record's claimed amount (getProgramAccounts
 *       filtered to dataSize 32 + the ClaimedRewards account discriminator)
 *   F = sum of totals over published rounds (the amount ever funded)
 *
 * Solvency: B + C < F  -> `solvency` CRITICAL (the vault cannot cover what
 * was funded minus what was claimed — funds went somewhere they shouldn't).
 * B + C > F is fine (someone sent extra) and logged as info.
 *
 * Because claims can land while we read, the procedure is
 * vault -> gPA -> vault and retries up to 5 times until the two vault reads
 * agree; if they never do, the last attempt stands with the LOWER vault
 * balance used for the solvency check (conservative) and the report marks
 * the read unstable.
 *
 * Overclaim: every claim record is mapped back to a wallet via
 * totals.claim_record. A record matching no wallet, or one whose claimed
 * amount exceeds the wallet's total in the tree for the CURRENT on-chain
 * root, raises `overclaim` CRITICAL.
 */

export interface OverclaimFinding {
    record: string;
    wallet: string | null; // null = record matched no wallet in totals
    claimed: bigint;
    treeTotal: bigint;
}

export interface ReconcileReport {
    /** true when no solvency violation and no overclaims. */
    ok: boolean;
    vaultBalance: bigint;
    claimedSum: bigint;
    fundedTotal: bigint;
    claimRecords: number;
    overclaims: OverclaimFinding[];
    /** true when the vault balance never stabilised across 5 attempts. */
    vaultUnstable: boolean;
}

const MAX_ATTEMPTS = 5;

async function readVaultBalance(connection: Connection, vault: PublicKey): Promise<bigint> {
    const bal = await connection.getTokenAccountBalance(vault, 'confirmed');
    return BigInt(bal.value.amount);
}

export async function reconcile(
    db: Db,
    cfg: JobConfig,
    alerter: Alerter,
    client: PoolClient
): Promise<ReconcileReport> {
    const connection = new Connection(cfg.rpcUrl, 'confirmed');
    const programId = new PublicKey(cfg.programId);
    const mint = new PublicKey(cfg.usdcMint);

    const onchain = await fetchOnChainConfig(connection, programId);
    const vault = deriveVault(mint, programId);
    if (!onchain.vault.equals(vault)) {
        // Preflight normally catches this first; refuse to reconcile nonsense.
        throw new Error(`on-chain token_vault ${onchain.vault} != derived ${vault}`);
    }
    const onChainRootHex = Buffer.from(onchain.root).toString('hex');

    // vault -> gPA -> vault, retrying while the vault moves under us.
    let vaultBalance = 0n;
    let claimedSum = 0n;
    let records: { record: string; claimed: bigint }[] = [];
    let vaultUnstable = true;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const b1 = await readVaultBalance(connection, vault);
        const accounts = await connection.getProgramAccounts(programId, {
            commitment: 'confirmed',
            filters: [
                { dataSize: 32 },
                { memcmp: { offset: 0, bytes: bs58.encode(CLAIMED_DISCRIMINATOR) } },
            ],
        });
        const b2 = await readVaultBalance(connection, vault);
        records = accounts.map((a) => ({
            record: a.pubkey.toBase58(),
            claimed: parseClaimedAmount(a.account.data as Buffer),
        }));
        claimedSum = records.reduce((a, r) => a + r.claimed, 0n);
        vaultBalance = b1 < b2 ? b1 : b2;
        if (b1 === b2) {
            vaultUnstable = false;
            vaultBalance = b1;
            break;
        }
    }

    // Solvency: B + C vs F.
    const funded = await db.fundedTotal(client);
    if (vaultBalance + claimedSum < funded) {
        await alerter.critical('solvency', `vault ${vaultBalance} + claimed ${claimedSum} < funded ${funded}`, {
            vaultBalance: vaultBalance.toString(),
            claimedSum: claimedSum.toString(),
            fundedTotal: funded.toString(),
            vaultUnstable,
        });
    } else if (vaultBalance + claimedSum > funded) {
        await alerter.info('solvency', `vault ${vaultBalance} + claimed ${claimedSum} > funded ${funded} (surplus)`, {
            vaultBalance: vaultBalance.toString(),
            claimedSum: claimedSum.toString(),
            fundedTotal: funded.toString(),
        });
    }

    // Overclaim: records -> wallets via totals.claim_record, vs the tree for
    // the on-chain root. Zero root means no tree: every claimed amount is
    // against a tree total of 0.
    const overclaims: OverclaimFinding[] = [];
    const byRecord = await db.walletsByClaimRecords(client, records.map((r) => r.record));
    const treeAvailable = onChainRootHex !== ZERO_ROOT_HEX && (await db.treeExists(client, onChainRootHex));
    for (const r of records) {
        const hit = byRecord.get(r.record);
        if (!hit) {
            overclaims.push({ record: r.record, wallet: null, claimed: r.claimed, treeTotal: 0n });
            continue;
        }
        let treeTotal = 0n;
        if (treeAvailable) {
            const proof = await db.getProof(client, onChainRootHex, hit.wallet);
            if (proof) treeTotal = BigInt(proof.total);
        }
        if (r.claimed > treeTotal) {
            overclaims.push({ record: r.record, wallet: hit.wallet, claimed: r.claimed, treeTotal });
        }
    }
    if (overclaims.length > 0) {
        await alerter.critical('overclaim', `${overclaims.length} claim record(s) exceed tree totals or match no wallet`, {
            onChainRoot: onChainRootHex,
            overclaims: overclaims.map((o) => ({
                record: o.record,
                wallet: o.wallet,
                claimed: o.claimed.toString(),
                treeTotal: o.treeTotal.toString(),
            })),
        });
    }

    return {
        ok: vaultBalance + claimedSum >= funded && overclaims.length === 0,
        vaultBalance,
        claimedSum,
        fundedTotal: funded,
        claimRecords: records.length,
        overclaims,
        vaultUnstable,
    };
}
