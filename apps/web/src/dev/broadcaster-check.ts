/**
 * DEVELOPMENT ONLY diagnostic: which Railgun broadcasters serve Sepolia, and
 * do any accept our test USDT for fees? Not imported by the app. Run with:
 *   DIAG=1 npx playwright test e2e/diag-broadcasters.spec.ts
 */
import '../railgun/polyfills.ts';
import { WakuBroadcasterClient } from '@railgun-community/waku-broadcaster-client-web';
import { NETWORK_CONFIG, NetworkName } from '@railgun-community/shared-models';
import { SEPOLIA_USDT } from '../railgun/protocol.ts';

export async function checkBroadcasters(waitMs = 90_000) {
  const chain = NETWORK_CONFIG[NetworkName.EthereumSepolia].chain;
  const statuses: string[] = [];
  // No trusted fee signer: list everyone (a discovery check, not a send).
  await WakuBroadcasterClient.start(chain, { trustedFeeSigner: '' }, (_chain, status) => statuses.push(String(status)));
  const t0 = Date.now();
  let all: unknown[] = [];
  while (Date.now() - t0 < waitMs) {
    await new Promise((r) => setTimeout(r, 5_000));
    all = WakuBroadcasterClient.findAllBroadcastersForChain(chain, false) ?? [];
    if (all.length > 0 && Date.now() - t0 > 30_000) break; // give fee messages time to arrive
  }
  const result = {
    connectionStatuses: [...new Set(statuses)],
    meshPeers: WakuBroadcasterClient.getMeshPeerCount(),
    pubSubPeers: WakuBroadcasterClient.getPubSubPeerCount(),
    broadcastersForSepolia: all.length,
    sampleTokens: [...new Set((all as { tokenAddress: string }[]).map((b) => b.tokenAddress))].slice(0, 10),
    acceptsOurUsdt: WakuBroadcasterClient.supportsToken(chain, SEPOLIA_USDT, false),
    usdtBroadcasters: (WakuBroadcasterClient.findBroadcastersForToken(chain, SEPOLIA_USDT, false) ?? []).length,
  };
  await WakuBroadcasterClient.stop();
  return result;
}
