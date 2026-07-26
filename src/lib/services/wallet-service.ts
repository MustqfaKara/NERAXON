import { isAddress } from "viem";
import { PublicKey } from "@solana/web3.js";
import { calculateWalletScore } from "@/lib/engine/wallet-scoring";
import type { ChainId, DiscoveryScoreBreakdown, TrackedWallet, WalletAdditionContext, WalletAdditionTokenSnapshot, WalletScoreBreakdown } from "@/lib/domain/types";
import { integrationName } from "@/lib/domain/integrations";
import { publishEvent } from "@/lib/services/audit-service";
import { store } from "@/lib/repositories/store";
import { formatDiscoveryWalletLabel } from "@/lib/utils/discovery-wallet-label";

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

export async function addTrackedWallet(address: string, label: string, discoveryScore?: DiscoveryWalletScore, observedSwapCount24h?: number, discoverySnapshot?: DiscoveryWalletSnapshotInput, chainId?: ChainId): Promise<TrackedWallet> {
  const requestedChainId = discoverySnapshot?.chainId ?? chainId;
  if (!requestedChainId) throw new Error("Cüzdanın takip edileceği ağı seçin.");
  if (requestedChainId === "solana") {
    try { new PublicKey(address.trim()); } catch { throw new Error("Geçerli bir Solana cüzdan adresi girin."); }
  } else if (!isAddress(address.toLowerCase())) throw new Error("Geçerli bir EVM cüzdan adresi girin.");
  const maxWalletSwapsPer24Hours = store.getRiskSettings().maxWalletSwapsPer24Hours ?? 50;
  if (observedSwapCount24h !== undefined && observedSwapCount24h > maxWalletSwapsPer24Hours) {
    throw new Error(`Bu cüzdan son 24 saatte ${observedSwapCount24h} swap yaptığı için ${maxWalletSwapsPer24Hours} işlem yoğunluğu sınırını aşıyor.`);
  }

  const existingWallet = store.findWalletByAddress(address);
  if (existingWallet?.trackedChainIds.includes(requestedChainId)) {
    throw new Error(`Bu cüzdan ${integrationName(requestedChainId)} ağı için zaten takip ediliyor.`);
  }
  if (existingWallet) {
    const updatedWallet = store.addWalletTrackedChain(existingWallet.id, requestedChainId, Boolean(discoverySnapshot));
    await publishEvent({
      chainId: requestedChainId,
      level: "info",
      type: "system",
      title: "Cüzdana yeni takip ağı eklendi",
      message: `${updatedWallet.label} artık ${integrationName(requestedChainId)} ağındaki işlemleri için de takip edilecek.`,
      txHash: null,
    });
    return updatedWallet;
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
    address: requestedChainId === "solana" ? address.trim() : address.toLowerCase(),
    label: discoverySnapshot ? formatDiscoveryWalletLabel(now) : label.trim() || `Cüzdan ${address.slice(0, 6)}`,
    isFavorite: false,
    trackedChainIds: [requestedChainId],
    state: discoverySnapshot ? "active" : "observing",
    score: scoring.score,
    scoreBreakdown: scoring.breakdown,
    totalTrades: 0,
    observationSwapCount: 0,
    copiedTradeCount: 0,
    winRate: 0,
    realizedPnlUsd: 0,
    copyPnlPercent: 0,
    copyInvestedUsd: 0,
    maxDrawdownPercent: 0,
    averageHoldMinutes: 0,
    pauseReason: null,
    additionContext,
    createdAt: now,
    updatedAt: now,
  };
  store.insertWallet(wallet);
  await publishEvent({
    chainId: requestedChainId,
    level: "info",
    type: "system",
    title: discoverySnapshot ? "Cüzdan takibi başlatıldı" : "Cüzdan gözleme alındı",
    message: discoverySnapshot
      ? `${wallet.label} (${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}) ${integrationName(requestedChainId)} ağında aktif izleme ve copy trade havuzuna eklendi.`
      : `${wallet.label} (${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}) geçmiş veri oluşana kadar gözlem modunda tutulacak.`,
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
