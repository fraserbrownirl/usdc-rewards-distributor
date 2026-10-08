// Devnet rehearsal fixture generator — spec §12.
// 14 rounds, all dated in the past so they pass validation rule 2
// ("round must be earlier than today"). 54 reward wallets:
//   [0] daily claimer      (receives every day, claims daily)
//   [1] end claimer        (receives every day, claims once at the end)
//   [2] no-ATA wallet      (receives every day, never has a USDC account;
//                          its claim relies on the SDK's CreateIdempotent ATA)
//   [3..53] background wallets (51 more, appear on day 3 only)
// Day 9 is the missing-funding day: generated like any other, but the run
// script will drain the operator USDC to 0 before ingesting it (expect a
// funding_missing pause), then funds the operator and re-runs.
// Day 13 is the empty day (total 0, count 0, rewards []).
//
// Round dates: START_DATE .. START_DATE+13, ending today or earlier.
// Override with: node gen-rehearsal-fixture.mjs [YYYY-MM-DD]
//
// CRITICAL: unlike the first draft of this script, all 54 keypairs are
// PERSISTED to scripts/rehearsal-claimants.json (mode 0600, git-ignored) —
// claims are impossible without the secret keys.
//
// Writes inbox/<round>.json atomically (tmp + rename), like the real producer.
import { Keypair } from '@solana/web3.js';
import { writeFileSync, renameSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';

const INBOX = new URL('../inbox/', import.meta.url).pathname;
const WALLETS = new URL('./rehearsal-claimants.json', import.meta.url).pathname;
mkdirSync(INBOX, { recursive: true });

// Default end date: today (UTC). All rounds then land strictly in the past
// except none — day 14 lands ON today only if... no: we back off one day so
// every round is < today (rule 2 rejects round >= today).
const today = new Date();
const end = new Date(process.argv[2] ? process.argv[2] + 'T00:00:00Z' : today.getTime());
// If the given/explicit end date is >= today, shift it back to yesterday.
const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
if (end >= todayUtc) end.setTime(todayUtc.getTime() - 86400000);

const DAYS = [];
for (let i = 13; i >= 0; i--) {
    const d = new Date(end.getTime() - i * 86400000);
    DAYS.push(d.toISOString().slice(0, 10));
}

const keypairs = Array.from({ length: 54 }, () => Keypair.generate());
const wallets = keypairs.map((k) => k.publicKey.toBase58());

for (let i = 0; i < DAYS.length; i++) {
    const round = DAYS[i];
    let rewards = [];
    if (i === 12) {
        // empty day
    } else {
        rewards = [0, 1, 2].map((w) => ({ wallet: wallets[w], amount: String((i + 1) * (w + 1)) }));
        if (i === 2) {
            for (let w = 3; w < 54; w++) rewards.push({ wallet: wallets[w], amount: String(w) });
        }
    }
    const total = rewards.reduce((a, r) => a + BigInt(r.amount), 0n).toString();
    const body = JSON.stringify(
        { version: 1, round, total, count: rewards.length, rewards },
        null,
        2
    );
    const tmp = join(INBOX, `.${round}.json.tmp`);
    writeFileSync(tmp, body);
    renameSync(tmp, join(INBOX, `${round}.json`));
}

// Persist ALL 54 keypairs so claim-as.mjs can sign as any of them.
writeFileSync(
    WALLETS,
    JSON.stringify(
        keypairs.map((k) => ({
            pubkey: k.publicKey.toBase58(),
            secret: Array.from(k.secretKey),
        })),
        null,
        1
    ) + '\n'
);
chmodSync(WALLETS, 0o600);

console.log(`wrote ${DAYS.length} rounds (${DAYS[0]}..${DAYS[13]}), 54 wallets`);
console.log(`daily claimer:  ${wallets[0]} (index 0)`);
console.log(`end claimer:    ${wallets[1]} (index 1)`);
console.log(`no-ATA wallet:  ${wallets[2]} (index 2)`);
console.log(`keypairs:       ${WALLETS} (0600)`);
console.log(`day 9 (missing-funding): ${DAYS[8]}`);
console.log(`day 13 (empty):          ${DAYS[12]}`);
