// Drain the operator's devnet USDC to a sink ATA (missing-funding setup).
// Usage: node scripts/drain-operator-usdc.mjs <amount-decimal-string> <sink-owner-pubkey>
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
    createAssociatedTokenAccountIdempotentInstruction,
    createTransferCheckedInstruction,
    getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { Transaction } from '@solana/web3.js';
import { readFileSync } from 'fs';

const [amount, sinkOwner] = process.argv.slice(2);
const RPC = 'https://api.devnet.solana.com';
const MINT = new PublicKey('4aa1VDp94MfisHLZpRpdgcLrQxTQknzP5bbLuo1uJhfT');

const operator = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf8')))
);
const sink = new PublicKey(sinkOwner);
const conn = new Connection(RPC, 'confirmed');

const operatorAta = getAssociatedTokenAddressSync(MINT, operator.publicKey);
const sinkAta = getAssociatedTokenAddressSync(MINT, sink);

const tx = new Transaction()
    .add(createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, sinkAta, sink, MINT))
    .add(createTransferCheckedInstruction(operatorAta, MINT, sinkAta, operator.publicKey, BigInt(amount), 6));
tx.feePayer = operator.publicKey;
const { blockhash } = await conn.getLatestBlockhash('finalized');
tx.recentBlockhash = blockhash;
tx.sign(operator);
const sig = await conn.sendRawTransaction(tx.serialize());
await conn.confirmTransaction(sig, 'finalized');
const bal = await conn.getTokenAccountBalance(operatorAta, 'confirmed');
console.log(`drained ${amount} to ${sinkAta.toBase58()} sig=${sig}`);
console.log(`operator USDC now: ${bal.value.amount}`);
