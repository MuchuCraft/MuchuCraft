// Mainnet cutover preflight — run from gateway/: node scripts/mainnet-preflight.mjs
// Refuses unless EVERY check passes. See docs/MAINNET-CUTOVER.md.
import { createSolanaRpc, address } from '@solana/kit';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { readFileSync } from 'node:fs';

try { process.loadEnvFile(new URL('../../.env', import.meta.url).pathname); } catch {}

const RPC_URL = process.env.MAINNET_RPC_URL || process.argv[2];
const MINT = process.env.MUCHU_MINT_MAINNET || 'R76wEBCrjipkHB8999utYpsECG6qM5S7a49YWKmuchu';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEgGkZwyTDt1v';
if (!RPC_URL) { console.error('usage: node scripts/mainnet-preflight.mjs <mainnet rpc url>  (or set MAINNET_RPC_URL)'); process.exit(2); }

const rpc = createSolanaRpc(RPC_URL);
let ok = true;
const check = (name, pass, detail) => { console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!pass) ok = false; };

// 1. RPC actually serves mainnet account data (catches filtered/mocked RPCs:
//    if USDC is unreadable, nothing this box concludes about mainnet is trustworthy).
const genesis = await rpc.getGenesisHash().send().catch(() => null);
check('RPC genesis hash is mainnet', genesis === '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', String(genesis));
const usdc = await rpc.getAccountInfo(address(USDC), { encoding: 'base64' }).send().catch(() => null);
check('RPC serves real account data (USDC mint readable)', Boolean(usdc?.value),
  usdc?.value ? undefined : 'USDC unreadable — RPC/egress cannot be trusted for mainnet');

// 2. The MUCHU mint exists and its properties are known.
const mint = await rpc.getAccountInfo(address(MINT), { encoding: 'jsonParsed' }).send().catch(() => null);
check(`MUCHU mint exists (${MINT.slice(0, 8)}…)`, Boolean(mint?.value));
let decimals = null;
if (mint?.value) {
  const p = mint.value.data.parsed.info;
  decimals = p.decimals;
  console.log(`      program=${mint.value.owner} decimals=${p.decimals} supply=${p.supply}`);
  console.log(`      mintAuthority=${p.mintAuthority ?? 'revoked'} freezeAuthority=${p.freezeAuthority ?? 'revoked'}`);
}

// 3. Treasury hot wallet funded: SOL for fees/ATA rent + MUCHU float to back balances.
const treasury = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(process.env.TREASURY_KEYPAIR_PATH))));
const sol = await rpc.getBalance(address(treasury.address)).send().catch(() => null);
check(`treasury ${treasury.address.slice(0, 8)}… has ≥ 0.1 SOL`, sol && Number(sol.value) >= 0.1e9, sol ? `${Number(sol.value) / 1e9} SOL` : 'unreadable');
if (mint?.value) {
  const tok = await rpc.getTokenAccountsByOwner(address(treasury.address), { mint: address(MINT) }, { encoding: 'jsonParsed' }).send().catch(() => null);
  const amt = tok?.value?.[0]?.account.data.parsed.info.tokenAmount;
  check('treasury holds MUCHU float', amt && BigInt(amt.amount) > 0n, amt ? `${amt.uiAmountString} MUCHU` : 'no token account');
}

console.log('');
if (ok) {
  console.log('ALL CHECKS PASSED. Flip .env to:');
  console.log(`  SOLANA_CLUSTER=mainnet-beta`);
  console.log(`  SOLANA_RPC_URL=${RPC_URL.replace(/api-key=[^&]+/, 'api-key=***')}`);
  console.log(`  MUCHU_MINT=${MINT}`);
  console.log(`  MUCHU_DECIMALS=${decimals}`);
  console.log('then restart the gateway and re-run this preflight plus /api/token/status.');
} else {
  console.log('PREFLIGHT FAILED — do NOT cut over. Fix the failures above first.');
  process.exit(1);
}
