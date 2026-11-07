/**
 * TESTNET ONLY. One-off: convert the test-funds pool's NEAR-side Tidepool USDT
 * (credited inside Tidepool's NEAR Intents verifier) into Tidepool's USDT on
 * Ethereum Sepolia, delivered to the same pool address. Approved by the team
 * lead 2026-11-07; flow confirmed by Tidepool's creator.
 *
 *   quote (depositType INTENTS) -> /v0/generate-intent (erc191)
 *   -> CHECK EVERY FIELD -> sign with the pool key -> /v0/submit-intent
 *   -> poll status -> confirm the USDT arrived on Sepolia
 *
 * Rehearsal by default: without --confirm it does everything except sign, and
 * prints the message it would sign. Never prints the recovery phrase, private
 * key or signature.
 *
 * Run from apps/server:
 *   npx tsx --env-file=../../.env src/scripts/pool-convert.ts --amount 1000 [--confirm]
 */
import { Contract, JsonRpcProvider, Signature, Wallet, encodeBase58, getAddress } from 'ethers';

const POOL = '0x9bd58CDFA143128e2Cd782cd17dC09f4F5c18FB1';
const POOL_ID = POOL.toLowerCase(); // NEAR Intents account id for an EVM address
const TIDEPOOL = 'https://www.usetidepool.tech';
const NEAR_RPC = 'https://rpc.testnet.near.org';
const SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const VERIFIER = 'verifier.tidepool-sandbox.testnet';
const ORIGIN = 'nep141:usdt.tidepool-sandbox.testnet';
const DEST = 'nep141:eth-0x650f12ba31777de8ded47287a8cc86be737646fe.tp-omft.testnet';
const SEPOLIA_USDT = '0x650F12bA31777DE8Ded47287a8CC86bE737646fe';
const MAX_BATCH = 50_000n * 1_000_000n; // Tidepool: keep batches within maker liquidity
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fail(msg: string): never {
  console.error(`STOPPED: ${msg}`);
  process.exit(1);
}

async function json(method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await fetch(TIDEPOOL + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !data) fail(`Tidepool ${path} answered ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

async function nearBalance(): Promise<bigint> {
  const args = Buffer.from(JSON.stringify({ account_id: POOL_ID, token_id: ORIGIN })).toString('base64');
  const res = await fetch(NEAR_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'query',
      params: { request_type: 'call_function', finality: 'final', account_id: VERIFIER, method_name: 'mt_balance_of', args_base64: args },
    }),
  });
  const r = (await res.json()) as { result?: { result?: number[] } };
  if (!r.result?.result) fail('Could not read the NEAR-side balance.');
  return BigInt(JSON.parse(Buffer.from(r.result.result).toString()) as string);
}

/** The message must be exactly one transfer of exactly `amount` ORIGIN to `depositAddress`, from us, for the verifier. */
function checkPayload(payload: string, amount: bigint, depositAddress: string) {
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    fail('The message to sign is not JSON.');
  }
  const keys = Object.keys(p).sort().join(',');
  if (keys !== 'deadline,intents,nonce,signer_id,verifying_contract') fail(`Unexpected fields in the message: ${keys}`);
  if (p.signer_id !== POOL_ID) fail(`Signer is ${String(p.signer_id)}, not our pool.`);
  if (p.verifying_contract !== VERIFIER) fail(`Contract is ${String(p.verifying_contract)}, not ${VERIFIER}.`);
  const deadline = Date.parse(String(p.deadline));
  if (!(deadline > Date.now() && deadline < Date.now() + 30 * 60_000)) fail(`Deadline ${String(p.deadline)} is not within the next 30 minutes.`);
  if (typeof p.nonce !== 'string' || Buffer.from(p.nonce, 'base64').length !== 32) fail('Nonce is not 32 bytes.');
  const intents = p.intents as Record<string, unknown>[];
  if (!Array.isArray(intents) || intents.length !== 1) fail('The message must contain exactly one instruction.');
  const i = intents[0]!;
  if (Object.keys(i).sort().join(',') !== 'intent,receiver_id,tokens') fail(`Unexpected fields in the instruction: ${Object.keys(i).join(',')}`);
  if (i.intent !== 'transfer') fail(`Instruction is "${String(i.intent)}", not "transfer".`);
  if (i.receiver_id !== depositAddress) fail('Instruction sends to a different address than the quote.');
  const tokens = i.tokens as Record<string, unknown>;
  if (Object.keys(tokens).length !== 1 || tokens[ORIGIN] !== amount.toString()) fail(`Instruction moves ${JSON.stringify(tokens)}, not exactly ${amount} ${ORIGIN}.`);
}

/** NEAR Intents' erc191 signature: "secp256k1:" + base58(r || s || v), v as recovery id 0/1. */
function encodeSignature(hex: string): string {
  const sig = Signature.from(hex);
  const bytes = Buffer.concat([Buffer.from(sig.r.slice(2), 'hex'), Buffer.from(sig.s.slice(2), 'hex'), Buffer.from([sig.yParity])]);
  return `secp256k1:${encodeBase58(bytes)}`;
}

async function main() {
  const argv = process.argv.slice(2);
  const confirm = argv.includes('--confirm');
  const amountArg = argv[argv.indexOf('--amount') + 1];
  if (!argv.includes('--amount') || !amountArg || !/^\d+$/.test(amountArg)) fail('Pass --amount <whole USDT>, e.g. --amount 1000.');
  const amount = BigInt(amountArg) * 1_000_000n;
  if (amount === 0n || amount > MAX_BATCH) fail('Batch must be between 1 and 50,000 USDT.');

  const phrase = process.env.TESTNET_POOL_MNEMONIC;
  if (!phrase) fail('TESTNET_POOL_MNEMONIC is not set (run with --env-file=../../.env).');
  const wallet = Wallet.fromPhrase(phrase);
  if (getAddress(wallet.address) !== POOL) fail('The phrase in .env does not give the pool address.');

  const sepolia = new JsonRpcProvider(SEPOLIA_RPC);
  if ((await sepolia.getNetwork()).chainId !== 11155111n) fail('Not Sepolia.');
  const usdt = new Contract(SEPOLIA_USDT, ['function balanceOf(address) view returns (uint256)'], sepolia);
  const before = (await usdt.balanceOf!(POOL)) as bigint;
  const near = await nearBalance();
  console.log(`Pool: NEAR-side ${Number(near) / 1e6} USDT, Sepolia ${Number(before) / 1e6} USDT. Batch: ${Number(amount) / 1e6}.`);
  if (near < amount) fail('Not enough NEAR-side USDT for this batch.');

  // 1. Quote, and check it is exactly what we asked for.
  const req = {
    dry: false,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: ORIGIN,
    destinationAsset: DEST,
    amount: amount.toString(),
    depositType: 'INTENTS',
    refundTo: POOL_ID,
    refundType: 'INTENTS',
    recipient: POOL,
    recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
  };
  const qr = await json('POST', '/v0/quote', req);
  const q = qr.quote as Record<string, string>;
  const echo = (qr.quoteRequest ?? {}) as Record<string, string>;
  if (echo.originAsset !== ORIGIN || echo.destinationAsset !== DEST || String(echo.recipient).toLowerCase() !== POOL_ID || echo.amount !== amount.toString()) {
    fail('The quote does not match the request.');
  }
  if (q.amountIn !== amount.toString() || !/^[0-9a-f]{64}$/.test(q.depositAddress ?? '')) fail('Invalid quote.');
  if (BigInt(q.minAmountOut ?? '0') < (amount * 97n) / 100n) fail(`Quote too low: at least ${q.minAmountOut} for ${amount}.`);
  console.log(`Quote: ${Number(amount) / 1e6} -> ${q.amountOutFormatted} Sepolia USDT (at least ${Number(q.minAmountOut) / 1e6}).`);

  // 2. The message to sign, checked field by field.
  const gen = await json('POST', '/v0/generate-intent', { type: 'swap_transfer', standard: 'erc191', signerId: POOL_ID, depositAddress: q.depositAddress });
  const intent = gen.intent as { standard?: string; payload?: unknown };
  if (intent?.standard !== 'erc191' || typeof intent.payload !== 'string') fail('Unexpected generate-intent answer.');
  checkPayload(intent.payload, amount, q.depositAddress!);
  console.log('Message checks passed. It says:');
  console.log(JSON.stringify(JSON.parse(intent.payload), null, 1));

  if (!confirm) {
    console.log('REHEARSAL: nothing signed or sent. Run again with --confirm to sign and submit.');
    return;
  }

  // 3. Sign (ERC-191 personal_sign) and submit through Tidepool's relay.
  const signature = encodeSignature(await wallet.signMessage(intent.payload));
  const sub = await json('POST', '/v0/submit-intent', { type: 'swap_transfer', signedData: { standard: 'erc191', payload: intent.payload, signature } });
  const tp = (sub.tidepool ?? {}) as Record<string, string>;
  console.log(`Submitted. intentHash ${String(sub.intentHash)}${tp.explorerUrl ? `, ${tp.explorerUrl}` : ''}`);

  // 4. Wait for the swap, then for the USDT on Sepolia.
  let status = '';
  for (let i = 0; i < 120 && !['SUCCESS', 'REFUNDED', 'FAILED'].includes(status); i++) {
    await sleep(5_000);
    status = String((await json('GET', `/v0/status?depositAddress=${q.depositAddress}`)).status);
  }
  console.log(`Swap status: ${status}`);
  if (status !== 'SUCCESS') fail('The swap did not succeed. Any refund goes back to the NEAR-side balance.');
  let after = before;
  for (let i = 0; i < 60 && after - before < BigInt(q.minAmountOut!); i++) {
    await sleep(5_000);
    after = (await usdt.balanceOf!(POOL)) as bigint;
  }
  const got = after - before;
  console.log(`Arrived on Sepolia: ${Number(got) / 1e6} USDT (pool now holds ${Number(after) / 1e6}).`);
  if (got < BigInt(q.minAmountOut!)) fail('Less than the quoted minimum has arrived so far. Check again before the next batch.');
  console.log('BATCH DONE.');
}

void main();
