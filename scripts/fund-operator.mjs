// Mint <amount-raw> devnet USDC to the operator ATA (operator is mint
// authority on the devnet rehearsal mint). Used to re-fund the operator
// after a missing-funding pause. Usage: node scripts/fund-operator.mjs <amount-raw>
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
    createAssociatedTokenAccountIdempotentInstruction,
    createMintToCheckedInstruction,
    getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { Transaction } from '@solana/web3.js';
import { readFileSync } from 'fs';

const [amount] = process.argv.slice(2);
if (!amount) {
    console.error('usage: node scripts/fund-operator.mjs <amount-raw>');
    process.exit(2);
}
const MINT = new PublicKey('4aa1VDp94MfisHLZpRpdgcLrQxTQknzP5bbLuo1uJhfT');
const operator = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf8')))
);
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
const ata = getAssociatedTokenAddressSync(MINT, operator.publicKey);
const tx = new Transaction()
    .add(createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, ata, operator.publicKey, MINT))
    .add(createMintToCheckedInstruction(MINT, ata, operator.publicKey, BigInt(amount), 6));
tx.feePayer = operator.publicKey;
const { blockhash } = await conn.getLatestBlockhash('finalized');
tx.recentBlockhash = blockhash;
tx.sign(operator);
const sig = await conn.sendRawTransaction(tx.serialize());
await conn.confirmTransaction(sig, 'finalized');
const bal = await conn.getTokenAccountBalance(ata, 'confirmed');
console.log(`minted ${amount} raw sig=${sig}`);
console.log(`operator USDC now: ${bal.value.amount}`);
