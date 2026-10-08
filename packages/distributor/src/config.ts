/**
 * Runtime configuration from environment variables. Fail fast on missing
 * or inconsistent values; refuse mainnet startup with a non-mainnet mint.
 */

export const MAINNET_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const DEVNET_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

export interface Config {
    cluster: 'mainnet' | 'devnet' | 'localnet';
    rpcUrl: string;
    programId: string;
    usdcMint: string;
    databaseUrl: string;
    operatorKeypairPath: string;
    inboxDir: string;
    priorityFeeMicrolamports: number;
    minOperatorSolLamports: number;
    alertWebhookUrl: string | null;
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

export function loadConfig(): Config {
    const clusterRaw = (process.env.CLUSTER ?? 'mainnet').toLowerCase();
    if (!['mainnet', 'devnet', 'localnet'].includes(clusterRaw)) {
        throw new Error(`CLUSTER must be mainnet|devnet|localnet, got '${clusterRaw}'`);
    }
    const cluster = clusterRaw as Config['cluster'];
    const usdcMint = required('USDC_MINT');
    if (cluster === 'mainnet' && usdcMint !== MAINNET_USDC_MINT) {
        throw new Error(
            `CLUSTER=mainnet but USDC_MINT is not the mainnet USDC mint (${MAINNET_USDC_MINT}); refusing to start`
        );
    }
    if (cluster === 'devnet' && usdcMint !== DEVNET_USDC_MINT) {
        throw new Error(
            `CLUSTER=devnet but USDC_MINT is not the devnet USDC mint (${DEVNET_USDC_MINT}); refusing to start`
        );
    }
    return {
        cluster,
        rpcUrl: required('RPC_URL'),
        programId: required('PROGRAM_ID'),
        usdcMint,
        databaseUrl: required('DATABASE_URL'),
        operatorKeypairPath: required('OPERATOR_KEYPAIR_PATH'),
        inboxDir: required('INBOX_DIR'),
        priorityFeeMicrolamports: intEnv('PRIORITY_FEE_MICROLAMPORTS', 10_000),
        minOperatorSolLamports: intEnv('MIN_OPERATOR_SOL_LAMPORTS', 50_000_000),
        alertWebhookUrl: process.env.ALERT_WEBHOOK_URL || null,
        apiPort: intEnv('API_PORT', 8080),
        corsOrigins: (process.env.CORS_ORIGINS ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        rateLimitPerMin: intEnv('RATE_LIMIT_PER_MIN', 60),
    };
}
