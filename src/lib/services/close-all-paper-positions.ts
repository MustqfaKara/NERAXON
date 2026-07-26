import { dexFeePercentFor } from "@/lib/engine/paper-execution-model";
import { executePaperTrade } from "@/lib/engine/paper-trading";
import { executeHypercoreManualTrade } from "@/lib/engine/hypercore-paper-trading";
import { store } from "@/lib/repositories/store";
import { publishEvent } from "@/lib/services/audit-service";
import { refreshDashboardMarkets } from "@/lib/services/dashboard-service";
import { resolveTokenQuote } from "@/lib/services/token-quote-service";
import { closeShadowExecutionLots, groupOpenShadowLots } from "@/lib/services/shadow-position-service";
import { refreshExecutionMarkets } from "@/lib/services/execution-accounting";

interface CloseResult {
  id: string;
  label: string;
  market: string;
  status: "closed" | "failed";
  error: string | null;
}

export async function closeAllPaperPositions() {
  if (store.getMode() !== "paper") throw new Error("Toplu pozisyon kapatma şu anda yalnızca paper modda kullanılabilir.");
  await refreshDashboardMarkets().catch(() => null);
  const evmPositions = store.listPositions();
  const hypercorePositions = store.listHypercorePositions();
  const results: CloseResult[] = [];

  for (const position of evmPositions) {
    try {
      const quote = await resolveTokenQuote(position.chainId, position.tokenAddress).catch(() => null);
      const trade = await executePaperTrade({
        chainId: position.chainId,
        side: "sell",
        tokenAddress: quote?.address ?? position.tokenAddress,
        tokenSymbol: quote?.symbol ?? position.tokenSymbol,
        tokenDecimals: quote?.decimals,
        pairAddress: quote?.market.pairAddress ?? position.pairAddress,
        priceUsd: quote?.market.priceUsd ?? position.currentPriceUsd,
        liquidityUsd: quote?.market.liquidityUsd,
        gasFeeUsd: quote?.gas.feeUsd,
        dexFeePercent: dexFeePercentFor(quote?.market.dexId),
        priceChange24hPercent: quote?.market.priceChange24hPercent,
        sellPercent: 100,
        slippagePercent: 0.5,
      });
      if (trade.status !== "confirmed") throw new Error(trade.reason);
      results.push({ id: position.id, label: position.tokenSymbol, market: position.chainId, status: "closed", error: null });
    } catch (error) {
      results.push({ id: position.id, label: position.tokenSymbol, market: position.chainId, status: "failed", error: messageOf(error) });
    }
  }

  for (const position of hypercorePositions) {
    try {
      await executeHypercoreManualTrade({
        coin: position.coin,
        positionId: position.id,
        marketType: position.marketType,
        positionSide: position.side,
        action: "close",
        closePercent: 100,
      });
      results.push({ id: position.id, label: position.coin, market: `hyperliquid:${position.marketType}`, status: "closed", error: null });
    } catch (error) {
      results.push({ id: position.id, label: position.coin, market: `hyperliquid:${position.marketType}`, status: "failed", error: messageOf(error) });
    }
  }

  const closedCount = results.filter((result) => result.status === "closed").length;
  const failedCount = results.length - closedCount;
  const remainingCount = store.listPositions().length + store.listHypercorePositions().length;
  await publishEvent({
    chainId: null,
    level: failedCount ? "warning" : "info",
    type: "system",
    title: "Toplu paper pozisyon kapatma tamamlandı",
    message: `${closedCount} pozisyon kapatıldı, ${failedCount} pozisyon kapatılamadı. Kalan açık pozisyon: ${remainingCount}.`,
    txHash: null,
  });
  return { requestedCount: results.length, closedCount, failedCount, remainingCount, results };
}

export async function closeAllTradingPositions() {
  const mode = store.getMode();
  if (mode === "paper") return closeAllPaperPositions();
  if (mode === "live") throw new Error("Canlı pozisyonların toplu kapatılması güvenlik gereği ayrı ayrı onaylanmalıdır.");

  await refreshExecutionMarkets("shadow").catch(() => null);
  const groups = groupOpenShadowLots();
  const results: CloseResult[] = [];
  for (const lots of groups) {
    const lot = lots[0];
    try {
      await closeShadowExecutionLots(lots, "close-all");
      results.push({ id: lot.id, label: lot.assetSymbol || lot.assetKey, market: lot.integrationId, status: "closed", error: null });
    } catch (error) {
      results.push({ id: lot.id, label: lot.assetSymbol || lot.assetKey, market: lot.integrationId, status: "failed", error: messageOf(error) });
    }
  }

  const closedCount = results.filter((result) => result.status === "closed").length;
  const failedCount = results.length - closedCount;
  const remainingCount = groupOpenShadowLots().length;
  await publishEvent({
    chainId: null,
    level: failedCount ? "warning" : "info",
    type: "system",
    title: "Toplu shadow pozisyon kapatma tamamlandı",
    message: `${closedCount} shadow pozisyon simüle edilerek kapatıldı, ${failedCount} pozisyon kapatılamadı. Kalan açık pozisyon: ${remainingCount}.`,
    txHash: null,
  });
  return { requestedCount: results.length, closedCount, failedCount, remainingCount, results };
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : "Pozisyon kapatılamadı.";
