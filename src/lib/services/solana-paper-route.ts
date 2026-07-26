import type { TradeSide } from "@/lib/domain/types";
import { SOLANA_LAMPORTS_PER_SOL, SOLANA_NATIVE_MINT } from "@/lib/solana/constants";
import { getJupiterQuote } from "@/lib/services/jupiter-api";
import { estimatePaperGas } from "@/lib/services/gas-estimator";

export async function getSolanaPaperRoute(input: {
  side: TradeSide;
  tokenAddress: string;
  tokenDecimals: number;
  grossUsd: number;
  tokenQuantity?: number;
  slippagePercent: number;
}) {
  const gas = await estimatePaperGas("solana");
  const amount = input.side === "buy"
    ? BigInt(Math.max(1, Math.floor(input.grossUsd / gas.nativePriceUsd * SOLANA_LAMPORTS_PER_SOL)))
    : decimalToBaseUnits(input.tokenQuantity ?? 0, input.tokenDecimals);
  const quote = await getJupiterQuote({
    inputMint: input.side === "buy" ? SOLANA_NATIVE_MINT : input.tokenAddress,
    outputMint: input.side === "buy" ? input.tokenAddress : SOLANA_NATIVE_MINT,
    amount,
    slippageBps: Math.max(1, Math.round(input.slippagePercent * 100)),
  });
  const inputDecimals = input.side === "buy" ? 9 : input.tokenDecimals;
  const inputPriceUsd = input.side === "buy" ? gas.nativePriceUsd : input.grossUsd / Math.max(input.tokenQuantity ?? 0, Number.EPSILON);
  const routeFeeUsd = quote.routePlan.reduce((total, step) => {
    if (step.swapInfo.feeMint !== quote.inputMint) return total;
    return total + Number(step.swapInfo.feeAmount) / 10 ** inputDecimals * inputPriceUsd;
  }, 0);
  return {
    gas,
    priceImpactPercent: Math.max(0, Number(quote.priceImpactPct) * 100),
    dexFeePercent: input.grossUsd > 0 ? routeFeeUsd / input.grossUsd * 100 : 0,
    routeLabels: [...new Set(quote.routePlan.map((step) => step.swapInfo.label).filter(Boolean))],
  };
}

function decimalToBaseUnits(value: number, decimals: number) {
  const safeDecimals = Math.max(0, Math.min(18, decimals));
  return BigInt(Math.max(0, Math.round(value * 10 ** safeDecimals)));
}
