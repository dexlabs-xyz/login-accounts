/**
 * TESTNET-ONLY SIMULATION. The real chain side of the testnet gas faucet.
 * The key comes from the environment (TESTNET_GAS_FAUCET_KEY) and is never
 * logged. It must be a fresh key used for nothing but this testnet faucet.
 */
import { JsonRpcProvider, Wallet } from 'ethers';
import type { GasSender } from './routes.ts';

export function ethersGasSender(rpcUrl: string, privateKey: string): GasSender {
  const provider = new JsonRpcProvider(rpcUrl);
  const wallet = new Wallet(privateKey, provider);
  return {
    async chainId() {
      return (await provider.getNetwork()).chainId;
    },
    balanceOf(address) {
      return provider.getBalance(address);
    },
    async send(to, amountWei) {
      const tx = await wallet.sendTransaction({ to, value: amountWei });
      return tx.hash;
    },
  };
}
