import type { EvmChainId } from "../domain/types.ts";

export function geckoTerminalNetworkForChain(chainId: EvmChainId) {
  if (chainId === "ethereum") return "eth";
  if (chainId === "base") return "base";
  if (chainId === "robinhood") return "robinhood";
  return null;
}
