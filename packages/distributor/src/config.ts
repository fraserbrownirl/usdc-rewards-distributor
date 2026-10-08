/**
 * Runtime configuration from environment variables (spec §11). Fail fast on
 * missing or inconsistent values; refuse mainnet startup with a non-mainnet
 * mint. The API never loads the operator key (spec §11 key handling).
 */

export const MAINNET_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export type Cluster = 'localnet' | 'devnet' | 'mainnet-beta';

/** Shared by every process that talks to the chain and/or the ledger. */
export interface BaseConfig {
    cluster: Cluster;
    rpcUrl: string;
    programId: string;
    usdcMint: string;
    databaseUrl: string;
    alertWebhookUrl: string | null;
}

/** The distributor CLI / job. */
export interface JobConfig extends BaseConfig {
    operatorKeypairPath: string;
    inboxDir: string;
    priorityFeeMicrolamports: number;
    minOperatorSolLamports: number;
}

/** The rewards API: no operator key, no inbox. */
export interface ApiConfig extends BaseConfig {
    apiPort: number;
    corsOrigins: string[];
    rateLimitPerMin: number;
}

function required(name: string): string {
    const v = process.env[name];
    if (v === undefined || v === '') throw new Error(`missing required env var ${name}`);
    return v;
}

function intEnv(name: string, def: number): number {
    const v = process.env[name];
    if (v === undefined || v === '') return def;
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`env var ${name} must be a non-negative integer, got '${v}'`);
    return n;
}

function baseConfig(): BaseConfig {
    const clusterRaw = (process.env.CLUSTER ?? 'mainnet-beta').toLowerCase();
    if (!['localnet', 'devnet', 'mainnet-beta'].includes(clusterRaw)) {
        throw new Error(`CLUSTER must be localnet|devnet|mainnet-beta, got '${clusterRaw}'`);
    }
    const cluster = clusterRaw as Cluster;
    const usdcMint = required('USDC_MINT');
    if (cluster === 'mainnet-beta' && usdcMint !== MAINNET_USDC_MINT) {
        throw new Error(
            `CLUSTER=mainnet-beta but USDC_MINT is not the mainnet USDC mint (${MAINNET_USDC_MINT}); refusing to start`
        );
    }
    return {
        cluster,
        rpcUrl: required('RPC_URL'),
        programId: required('PROGRAM_ID'),
        usdcMint,
        databaseUrl: required('DATABASE_URL'),
        alertWebhookUrl: process.env.ALERT_WEBHOOK_URL || null,
    };
}

/** DB-only config for commands that never touch the chain (migrate, verify-file). */
export function loadDbUrl(): string {
    return required('DATABASE_URL');
}

/** Job / distributor CLI. Requires the operator keypair path. */
export function loadJobConfig(): JobConfig {
    return {
        ...baseConfig(),
        operatorKeypairPath: required('OPERATOR_KEYPAIR_PATH'),
        inboxDir: required('INBOX_DIR'),
        priorityFeeMicrolamports: intEnv('PRIORITY_FEE_MICROLAMPORTS', 10_000),
        minOperatorSolLamports: intEnv('MIN_OPERATOR_SOL_LAMPORTS', 50_000_000),
    };
}

/** Rewards API. Never touches the operator key. */
export function loadApiConfig(): ApiConfig {
    return {
        ...baseConfig(),
        apiPort: intEnv('API_PORT', 8080),
        corsOrigins: (process.env.CORS_ORIGINS ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        rateLimitPerMin: intEnv('RATE_LIMIT_PER_MIN', 60),
    };
}
