// Daily claimer driver: claims as rehearsal wallet index 0 against the local
// API, repeatedly, as new rounds publish. Run after each publish day during
// the rehearsal. Usage: node scripts/claim-daily.mjs <api-url>
//
// Unlike claim-as.mjs this is idempotent-friendly: if there is nothing to
// claim (total == claimed) it reports that and exits 0 instead of throwing.
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { readFileSync } from 'fs';
import { claimWithRetry } from '../packages/claim-sdk/dist/index.js';

const [apiUrl] = process.argv.slice(2);
const RPC = 'https://api.devnet.solana.com';
const PROGRAM_ID = new PublicKey('6S7aGNpCdT8ADoVXUwQXJqVg63GRx9uteHDAycngyQcK');
const MINT = new PublicKey('4aa1VDp94MfisHLZpRpdgcLrQxTQknzP5bbLuo1uJhfT');

const claimants = JSON.parse(readFileSync(new URL('./rehearsal-claimants.json', import.meta.url), 'utf8'));
const entry = claimants[0];
const claimant = Keypair.fromSecretKey(Uint8Array.from(entry.secret));
const conn = new Connection(RPC, 'confirmed');

const res = await fetch(`${apiUrl}/v1/rewards/${claimant.publicKey.toBase58()}`);
const info = await res.json();
if (BigInt(info.claimable) === 0n) {
    console.log(`daily claimer: nothing to claim (total ${info.total}, claimed ${info.claimed})`);
    process.exit(0);
}

const { signature, retried } = await claimWithRetry({
    connection: conn,
    apiBaseUrl: apiUrl,
    programId: PROGRAM_ID,
    mint: MINT,
    wallet: claimant.publicKey,
    priorityFeeMicroLamports: 1000,
    signAndSend: async (tx) => {
        tx.feePayer = claimant.publicKey;
        const { blockhash } = await conn.getLatestBlockhash('finalized');
        tx.recentBlockhash = blockhash;
        tx.sign(claimant);
        const sig = await conn.sendRawTransaction(tx.serialize());
        await conn.confirmTransaction(sig, 'finalized');
        return sig;
    },
});
console.log(`daily claimer claimed ${info.claimable} (total ${info.total}) sig=${signature} retried=${retried}`);
