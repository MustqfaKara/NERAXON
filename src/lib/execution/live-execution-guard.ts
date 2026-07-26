import { getAddress, type Address } from "viem";
import type { EvmChainId, RiskSettings } from "@/lib/domain/types";
import type { EvmAdapterPlan } from "@/lib/execution/evm-execution-adapter";
import { getPublicClient } from "@/lib/chains/public-client";
import { estimatePaperGas } from "@/lib/services/gas-estimator";
import { calculateGasFeeUsd } from "@/lib/services/gas-calculation";
import { quoteNativeValueUsd } from "@/lib/execution/evm-execution-math";
import { assertExecutionContractPolicy, LIFI_DIAMOND, ZERO_EX_ALLOWANCE_HOLDER } from "@/lib/execution/evm-route-validation";

const ROBINHOOD_ROUTER = getAddress("0x8876789976decbfcbbbe364623c63652db8c0904");

export async function assertEvmExecutionRisk(input: {
  chainId: EvmChainId;
  plan: EvmAdapterPlan;
  settings: RiskSettings;
  estimatedTradeUsd?: number;
}) {
  const gas = await estimatePaperGas(input.chainId);
  const quotedGasFeeUsd = estimateQuotedTransactionGasUsd(input.chainId, input.plan, gas.nativePriceUsd);
  const gasFeeUsd = quotedGasFeeUsd ?? gas.feeUsd;
  const estimatedTradeUsd = input.estimatedTradeUsd ?? estimateNativeTradeUsd(input.plan, gas.nativePriceUsd);
  if (estimatedTradeUsd <= 0) throw new Error("Canlı işlem USD değeri doğrulanamadı.");
  if (estimatedTradeUsd > (input.settings.maxLiveTradeUsd ?? 25)) {
    throw new Error(`Canlı işlem ${estimatedTradeUsd.toFixed(2)} USD ile ${(input.settings.maxLiveTradeUsd ?? 25).toFixed(2)} USD sınırını aşıyor.`);
  }
  const target = getAddress(input.plan.transaction.to);
  if ("provider" in input.plan) {
    assertExecutionContractPolicy({
      provider: input.plan.provider,
      sellToken: input.plan.sellToken,
      transactionTarget: target,
      allowanceSpender: input.plan.allowanceSpender,
    });
  } else if (input.chainId !== "robinhood" || target !== ROBINHOOD_ROUTER) {
    throw new Error("Robinhood işlemi resmî Universal Router kontratını hedeflemiyor.");
  }
  const code = await getPublicClient(input.chainId).getCode({ address: target });
  if (!code || code === "0x") throw new Error("Swap hedef kontratında zincir üstü bytecode bulunamadı.");
  return { gasFeeUsd, nativePriceUsd: gas.nativePriceUsd, estimatedTradeUsd };
}

export function estimateNativeTradeUsd(plan: EvmAdapterPlan, nativePriceUsd: number) {
  return quoteNativeValueUsd(plan.side, plan.sellAmount, plan.buyAmount, nativePriceUsd);
}

function estimateQuotedTransactionGasUsd(chainId: EvmChainId, plan: EvmAdapterPlan, nativePriceUsd: number) {
  if (!("provider" in plan)) return null;
  const gasUnits = plan.transaction.gas;
  const gasPrice = plan.transaction.gasPrice;
  if (!gasUnits || !gasPrice || gasUnits <= 0n || gasPrice <= 0n) return null;
  return calculateGasFeeUsd(chainId, gasPrice, gasUnits, nativePriceUsd);
}

export function configuredAllowedTargets(chainId: EvmChainId): Address[] {
  if (chainId === "robinhood") return [ROBINHOOD_ROUTER];
  return [ZERO_EX_ALLOWANCE_HOLDER, LIFI_DIAMOND];
}
