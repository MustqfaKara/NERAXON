import { formatUnits } from "viem";
import { SOLANA_BASE_SIGNATURE_FEE_LAMPORTS, SOLANA_NATIVE_MINT } from "../solana/constants.ts";

export function estimateSolanaNetworkFeeLamports(priorityFeeLamports: number) {
  return Math.max(0, Math.trunc(priorityFeeLamports)) + SOLANA_BASE_SIGNATURE_FEE_LAMPORTS;
}

export function calculateSolanaBuyTransactionCosts(input: {
  preBalanceLamports: bigint;
  postBalanceLamports: bigint;
  swapInputLamports: bigint;
  networkFeeLamports: bigint;
}) {
  const balanceReduction = input.preBalanceLamports - input.postBalanceLamports;
  const refundableRentLamports = balanceReduction - input.swapInputLamports - input.networkFeeLamports;
  return {
    networkFeeLamports: input.networkFeeLamports,
    refundableRentLamports: refundableRentLamports > 0n ? refundableRentLamports : 0n,
  };
}

export function estimateSolanaRouteFeeUsd(
  quote: { routePlan: Array<{ swapInfo: { feeAmount: string; feeMint: string } }> },
  nativePriceUsd: number,
  tokenPriceUsd: number,
  tokenDecimals: number,
) {
  return quote.routePlan.reduce((total, step) => {
    const decimals = step.swapInfo.feeMint === SOLANA_NATIVE_MINT ? 9 : tokenDecimals;
    const priceUsd = step.swapInfo.feeMint === SOLANA_NATIVE_MINT ? nativePriceUsd : tokenPriceUsd;
    return total + Number(formatUnits(BigInt(step.swapInfo.feeAmount || "0"), decimals)) * priceUsd;
  }, 0);
}
