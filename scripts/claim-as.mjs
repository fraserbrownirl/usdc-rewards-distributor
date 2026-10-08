// Rehearsal claim driver: claims as a given rehearsal wallet against the
// local API. The wallet keypairs are throwaway (pubkeys only were used in the
// round files); we derive nothing — we regenerate them from the fixture? No:
// the fixture only wrote pubkeys. So claims must come from wallets whose
// private keys we control. Solution: this script reads a secret key file
// produced by gen-rehearsal-claimants.mjs, which deterministically regenerates
// the SAME 54 keypairs? Also no — Keypair.generate() is random.
//
// So the fixture is regenerated for claims: see gen-claimant-wallets.mjs.
// This script expects: node scripts/claim-as.mjs <index> <api-url>
// and reads scripts/rehearsal-claimants.json (written by gen-claimant-wallets).
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { readFileSync } from 'fs';
import { claimWithRetry } from '../packages/claim-sdk/dist/index.js';

const [idx, apiUrl] = process.argv.slice(2);
const RPC = 'https://api.devnet.solana.com';
const PROGRAM_ID = new PublicKey('6S7aGNpCdT8ADoVXUwQXJqVg63GRx9uteHDAycngyQcK');
const MINT = new PublicKey('4aa1VDp94MfisHLZpRpdgcLrQxTQknzP5bbLuo1uJhfT');

const claimants = JSON.parse(readFileSync(new URL('./rehearsal-claimants.json', import.meta.url), 'utf8'));
const entry = claimants[Number(idx)];
const claimant = Keypair.fromSecretKey(Uint8Array.from(entry.secret));
const conn = new Connection(RPC, 'confirmed');

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
console.log(`claimed as wallet[${idx}] ${claimant.publicKey.toBase58()} sig=${signature} retried=${retried}`);
