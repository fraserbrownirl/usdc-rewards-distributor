#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
    Connection,
    Keypair,
    PublicKey,
    SystemProgram,
    Transaction,
    TransactionInstruction,
} from '@solana/web3.js';
import {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    getAssociatedTokenAddressSync,
    TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { JobConfig, loadDbUrl, loadJobConfig } from './config';
import { Db } from './db';
import { Alerter } from './alerts';
import { fileSha256, validateRoundFile } from './fileValidation';
import { CriticalStop, loadOperatorKeypair, reconcileCommand, runJob } from './run';
import {
    configPda,
    deriveVault,
    fetchClaimed,
    fetchOnChainConfig,
    ZERO_ROOT_HEX,
} from './publish';

/**
 * CLI — spec §5/§13. `run` is the daily job (advisory-locked 12-step loop);
 * the rest are operational one-offs. Exit codes: 0 ok, 1 failure, 2 usage.
 * DB-only commands (migrate, verify-file) don't require chain env vars.
 */

const DB_ONLY = new Set(['migrate', 'verify-file']);

function keypairFromArg(arg: string): Keypair {
    // --private-key-file only, never a raw key (spec §11).
    return loadOperatorKeypair(arg);
}

const INITIALIZE_DISCRIMINATOR = Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]);

/** initialize(updater) — spec §13. Config PDA + its ATA vault, one tx. */
async function adminInitialize(cfg: JobConfig, operator: Keypair, updater: PublicKey): Promise<string> {
    const connection = new Connection(cfg.rpcUrl, 'confirmed');
    const programId = new PublicKey(cfg.programId);
    const mint = new PublicKey(cfg.usdcMint);
    const config = configPda(programId);
    const vault = getAssociatedTokenAddressSync(mint, config, true);
    const programData = PublicKey.findProgramAddressSync([programId.toBuffer()], new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'))[0];

    const data = Buffer.alloc(8 + 32);
    INITIALIZE_DISCRIMINATOR.copy(data, 0);
    updater.toBuffer().copy(data, 8);
    const ix = new TransactionInstruction({
        programId,
        keys: [
            { pubkey: config, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: vault, isSigner: false, isWritable: true },
            { pubkey: operator.publicKey, isSigner: true, isWritable: true }, // admin
            { pubkey: programData, isSigner: false, isWritable: false },
            { pubkey: programId, isSigner: false, isWritable: false }, // program
            { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
    });
    const tx = new Transaction().add(ix);
    tx.feePayer = operator.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash('finalized')).blockhash;
    tx.sign(operator);
    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(sig, 'finalized');
    return sig;
}

async function printStatus(db: Db, cfg: JobConfig): Promise<void> {
    const connection = new Connection(cfg.rpcUrl, 'confirmed');
    const programId = new PublicKey(cfg.programId);
    const mint = new PublicKey(cfg.usdcMint);
    const operator = loadOperatorKeypair(cfg.operatorKeypairPath);
    const onchain = await fetchOnChainConfig(connection, programId);
    const vault = deriveVault(mint, programId);
    const vaultBal = await connection
        .getTokenAccountBalance(vault, 'confirmed')
        .then((b) => b.value.amount)
        .catch(() => null);
    const operatorAta = getAssociatedTokenAddressSync(mint, operator.publicKey);
    const operatorUsdc = await connection
        .getTokenAccountBalance(operatorAta, 'confirmed')
        .then((b) => b.value.amount)
        .catch(() => null);
    const operatorSol = await connection.getBalance(operator.publicKey, 'confirmed').catch(() => null);
    const latestPublished = await db.latestRound(undefined, ['published']);
    const pending = await db.pendingIngestedRound(undefined);
    const root = Buffer.from(onchain.root).toString('hex');
    console.log(
        JSON.stringify(
            {
                programId: cfg.programId,
                config: configPda(programId).toBase58(),
                vault: vault.toBase58(),
                mint: cfg.usdcMint,
                admin: onchain.admin.toBase58(),
                updater: onchain.updater.toBase58(),
                shutdown: onchain.shutdown,
                root: root === ZERO_ROOT_HEX ? 'zero (uninitialized)' : root,
                operator: operator.publicKey.toBase58(),
                operatorUsdc,
                operatorSolLamports: operatorSol,
                vaultBalance: vaultBal,
                latestPublishedRound: latestPublished
                    ? { round: latestPublished.round, root: latestPublished.root, signature: latestPublished.publish_signature }
                    : null,
                pendingRound: pending?.round ?? null,
            },
            null,
            2
        )
    );
}

async function exportOutstanding(db: Db, cfg: JobConfig, outPath: string): Promise<void> {
    const connection = new Connection(cfg.rpcUrl, 'confirmed');
    const programId = new PublicKey(cfg.programId);
    const onchain = await fetchOnChainConfig(connection, programId);
    const rootHex = Buffer.from(onchain.root).toString('hex');
    if (rootHex === ZERO_ROOT_HEX) {
        console.log('on-chain root is zero — nothing outstanding');
        return;
    }
    const tree = await db.getTree(undefined, rootHex);
    if (!tree) throw new Error(`on-chain root ${rootHex} not found in stored trees`);
    const totals = await db.allTotals(undefined);
    const rewards: { wallet: string; amount: string }[] = [];
    let sum = 0n;
    for (const [wallet] of totals) {
        const proof = await db.getProof(undefined, rootHex, wallet);
        if (!proof) continue;
        const claimed = await fetchClaimed(connection, programId, new PublicKey(wallet)).catch(() => 0n);
        const outstanding = BigInt(proof.total) - claimed;
        if (outstanding > 0n) {
            rewards.push({ wallet, amount: outstanding.toString() });
            sum += outstanding;
        }
    }
    const round = tree.round;
    writeFileSync(
        outPath,
        JSON.stringify({ version: 1, round, total: sum.toString(), count: rewards.length, rewards }, null, 2) + '\n'
    );
    console.log(`wrote ${outPath}: ${rewards.length} wallets, total outstanding ${sum} (tree root ${rootHex.slice(0, 12)}…)`);
}

async function main(): Promise<number> {
    const [cmd, ...args] = process.argv.slice(2);
    const cfg = DB_ONLY.has(cmd ?? '') ? null : loadJobConfig();
    const db = new Db(cfg ? cfg.databaseUrl : loadDbUrl(), cfg?.programId ?? null);
    const alerter = new Alerter(cfg?.alertWebhookUrl ?? null);
    const migrationsDir = join(__dirname, '..', '..', '..', 'migrations');

    try {
        switch (cmd) {
            case 'migrate': {
                const applied = await db.migrate(migrationsDir);
                console.log(applied.length ? `applied migrations: ${applied.join(', ')}` : 'no pending migrations');
                return 0;
            }

            case 'run': {
                const result = await db.withAdvisoryLock((client) => runJob(db, cfg!, alerter, client));
                if (result === null) {
                    console.log('another run holds the advisory lock — exiting');
                    return 0;
                }
                return result;
            }

            case 'reconcile': {
                const { ok, report } = await reconcileCommand(db, cfg!, alerter);
                console.log(
                    JSON.stringify(
                        {
                            ok,
                            vaultBalance: report.vaultBalance.toString(),
                            claimedSum: report.claimedSum.toString(),
                            fundedTotal: report.fundedTotal.toString(),
                            claimRecords: report.claimRecords,
                            vaultUnstable: report.vaultUnstable,
                            overclaims: report.overclaims.map((o) => ({
                                record: o.record,
                                wallet: o.wallet,
                                claimed: o.claimed.toString(),
                                treeTotal: o.treeTotal.toString(),
                            })),
                        },
                        null,
                        2
                    )
                );
                return ok ? 0 : 1;
            }

            case 'status': {
                await printStatus(db, cfg!);
                return 0;
            }

            case 'verify-file': {
                const file = args[0];
                if (!file) {
                    console.error('usage: distributor verify-file <path/to/YYYY-MM-DD.json>');
                    return 2;
                }
                const raw = readFileSync(file);
                const fileName = file.split('/').pop()!;
                const prev = await db.lastIngestedRound();
                const totals = await db.allTotals();
                try {
                    const parsed = validateRoundFile(
                        fileName,
                        raw,
                        { round: prev?.round ?? null, fileSha256: prev?.file_sha256 ?? null },
                        totals
                    );
                    console.log(
                        `valid: round ${parsed.round}, ${parsed.rewards.length} wallets, total ${parsed.total}${parsed.isEmpty ? ' (empty day)' : ''}, sha256 ${fileSha256(raw)}`
                    );
                    return 0;
                } catch (e) {
                    console.error(`invalid: ${(e as Error).message}`);
                    return 1;
                }
            }

            case 'export-outstanding': {
                const out = args[0];
                if (!out) {
                    console.error('usage: distributor export-outstanding <output.json>');
                    return 2;
                }
                await exportOutstanding(db, cfg!, out);
                return 0;
            }

            case 'admin': {
                const sub = args[0];
                if (sub !== 'initialize') {
                    console.error('usage: distributor admin initialize --private-key-file <path> [--updater <pubkey>]');
                    return 2;
                }
                let keyPath: string | null = null;
                let updater: string | null = null;
                for (let i = 1; i < args.length; i++) {
                    if (args[i] === '--private-key-file') keyPath = args[++i];
                    else if (args[i] === '--updater') updater = args[++i];
                }
                if (!keyPath) {
                    console.error('usage: distributor admin initialize --private-key-file <path> [--updater <pubkey>]');
                    return 2;
                }
                const operator = keypairFromArg(keyPath);
                const updaterKey = updater ? new PublicKey(updater) : operator.publicKey;
                const sig = await adminInitialize(cfg!, operator, updaterKey);
                console.log(`initialized: config=${configPda(new PublicKey(cfg!.programId)).toBase58()} vault=${deriveVault(new PublicKey(cfg!.usdcMint), new PublicKey(cfg!.programId)).toBase58()} sig=${sig}`);
                return 0;
            }

            default:
                console.error(
                    'usage: distributor <migrate|run|reconcile|status|verify-file|export-outstanding|admin initialize>'
                );
                return 2;
        }
    } catch (e) {
        if (e instanceof CriticalStop) {
            console.error(`stopped: ${e.alertName}: ${e.message}`);
            return 1;
        }
        throw e;
    } finally {
        await db.close();
    }
}

main()
    .then((code) => process.exit(code))
    .catch((e) => {
        console.error(`fatal: ${(e as Error).message}`);
        process.exit(1);
    });
