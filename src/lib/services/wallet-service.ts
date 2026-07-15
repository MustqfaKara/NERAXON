import { isAddress } from "viem";
import { calculateWalletScore } from "@/lib/engine/wallet-scoring";
import type { ChainId, DiscoveryScoreBreakdown, TrackedWallet, WalletAdditionContext, WalletAdditionTokenSnapshot, WalletScoreBreakdown } from "@/lib/domain/types";
import { publishEvent } from "@/lib/services/audit-service";
import { store } from "@/lib/repositories/store";

export interface DiscoveryWalletScore {
  score: number;
  breakdown: DiscoveryScoreBreakdown;
}

export interface DiscoveryWalletSnapshotInput {
  chainId: ChainId;
  boughtUsd: number;
  soldUsd: number;
  currentValueUsd: number;
  estimatedPnlUsd: number;
  estimatedPnlPercent: number;
  swapCount: number;
  buyCount: number;
  sellCount: number;
  uniqueTokenCount: number;
  tokens: WalletAdditionTokenSnapshot[];
}

export async function addTrackedWallet(address: string, label: string, discoveryScore?: DiscoveryWalletScore, observedSwapCount24h?: number, discoverySnapshot?: DiscoveryWalletSnapshotInput): Promise<TrackedWallet> {
  if (!isAddress(address.toLowerCase())) throw new Error("Geçerli bir EVM cüzdan adresi girin.");
  if (store.findWalletByAddress(address)) throw new Error("Bu cüzdan zaten takip ediliyor.");
  const maxWalletSwapsPer24Hours = store.getRiskSettings().maxWalletSwapsPer24Hours ?? 25;
  if (observedSwapCount24h !== undefined && observedSwapCount24h > maxWalletSwapsPer24Hours) {
    throw new Error(`Bu cüzdan son 24 saatte ${observedSwapCount24h} swap yaptığı için ${maxWalletSwapsPer24Hours} işlem yoğunluğu sınırını aşıyor.`);
  }

  const now = new Date().toISOString();
  const scoring = discoveryScore
    ? { score: discoveryScore.score, breakdown: mapDiscoveryBreakdown(discoveryScore.breakdown) }
    : calculateWalletScore();
  const additionContext: WalletAdditionContext = discoverySnapshot
    ? {
        source: "discovery",
        reason: `Son 24 saatlik yükselen token taramasında ${discoverySnapshot.uniqueTokenCount} token üzerinde ${discoverySnapshot.swapCount} swap ve ${formatUsd(discoverySnapshot.estimatedPnlUsd)} tahmini net PnL ile keşfedildi.`,
        capturedAt: now,
        ...discoverySnapshot,
      }
    : {
        source: "manual",
        reason: "Cüzdan adresi kullanıcı tarafından manuel olarak takip listesine eklendi.",
        capturedAt: now,
        chainId: null,
        boughtUsd: 0,
        soldUsd: 0,
        currentValueUsd: 0,
        estimatedPnlUsd: 0,
        estimatedPnlPercent: 0,
        swapCount: 0,
        buyCount: 0,
        sellCount: 0,
        uniqueTokenCount: 0,
        tokens: [],
      };
  const wallet: TrackedWallet = {
    id: crypto.randomUUID(),
    address: address.toLowerCase(),
    label: label.trim() || `Cüzdan ${address.slice(0, 6)}`,
    state: "observing",
    score: scoring.score,
    scoreBreakdown: scoring.breakdown,
    totalTrades: 0,
    observationSwapCount: 0,
    copiedTradeCount: 0,
    winRate: 0,
    realizedPnlUsd: 0,
    maxDrawdownPercent: 0,
    averageHoldMinutes: 0,
    pauseReason: null,
    additionContext,
    createdAt: now,
    updatedAt: now,
  };
  store.insertWallet(wallet);
  await publishEvent({
    chainId: null,
    level: "info",
    type: "system",
    title: "Cüzdan gözleme alındı",
    message: `${wallet.label} (${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}) geçmiş veri oluşana kadar gözlem modunda tutulacak.`,
    txHash: null,
  });
  return wallet;
}

const formatUsd = (value: number) => new Intl.NumberFormat("tr-TR", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);

export function mapDiscoveryBreakdown(breakdown: DiscoveryScoreBreakdown): WalletScoreBreakdown {
  return {
    profitability: breakdown.profitability,
    consistency: breakdown.balance,
    riskControl: breakdown.diversity,
    copyability: breakdown.activity,
    safety: breakdown.freshness,
  };
}
