import type { ChainAdapter, ObservedTransaction } from "@/lib/chains/chain-adapter";
import type { ChainId, Trade, TrackedWallet } from "@/lib/domain/types";
import { executePaperTrade, recordSkippedPaperTrade, type PaperTradeContext } from "@/lib/engine/paper-trading";
import { dexFeePercentFor } from "@/lib/engine/paper-execution-model";
import { evaluateTokenSafety } from "@/lib/engine/token-security";
import { store } from "@/lib/repositories/store";
import { publishEvent } from "@/lib/services/audit-service";
import { getMarketDataProvider } from "@/lib/services/market-data-provider";
import { inspectContractSecurity, mergeTokenSafety } from "@/lib/services/contract-security-service";
import type { Address } from "viem";

export async function processCopyableSwap(
  chainId: ChainId,
  wallet: TrackedWallet,
  transaction: ObservedTransaction,
  adapter: ChainAdapter,
): Promise<Trade | null> {
  const observation = await adapter.analyzeSwap(transaction);
  if (!observation) {
    store.recordWalletObservation(wallet.id, "swap", false);
    await publishEvent({
      chainId,
      level: "warning",
      type: "swap",
      title: "Swap çözümlenemedi",
      message: `${wallet.label} işlemi swap çağrısı içeriyor ancak cüzdan yönündeki token hareketi güvenle belirlenemedi. İşlem kopyalanmadı.`,
      txHash: transaction.hash,
    });
    return null;
  }

  const context: PaperTradeContext = {
    source: "copy",
    walletId: wallet.id,
    walletScore: wallet.score,
    sourceLabel: wallet.label,
    txHash: transaction.hash,
  };
  const consensus = observation.side === "buy"
    ? store.registerCopyBuySignal(chainId, observation.tokenAddress, wallet.id, transaction.hash)
    : null;
  if (consensus && !consensus.shouldCopy) {
    const reason = `${observation.tokenSymbol} için ${consensus.distinctWalletCount} farklı cüzdan alımı görüldü. Sonraki paper alım için ${consensus.requiredWalletCount} farklı cüzdan gerekiyor.`;
    const trade = await recordSkippedPaperTrade({
      chainId,
      side: observation.side,
      tokenAddress: observation.tokenAddress,
      tokenSymbol: observation.tokenSymbol,
      priceUsd: 0,
    }, reason, context);
    store.recordWalletObservation(wallet.id, "swap", false);
    return trade;
  }
  context.allowConsensusBuy = consensus?.shouldCopy ?? false;
  const missingSellPosition = observation.side === "sell" && !store.listPositionLots(chainId, observation.tokenAddress, wallet.id).length
    ? `${observation.tokenSymbol} için bu cüzdana bağlı açık pozisyon bulunmadığından satış uygulanmadı.`
    : null;
  if (missingSellPosition) {
    if (consensus?.shouldCopy) store.finishCopyBuyStage(chainId, observation.tokenAddress, consensus.stage, false);
    const trade = await recordSkippedPaperTrade({
      chainId,
      side: observation.side,
      tokenAddress: observation.tokenAddress,
      tokenSymbol: observation.tokenSymbol,
      priceUsd: 0,
    }, missingSellPosition, context);
    store.recordWalletObservation(wallet.id, "swap", false);
    return trade;
  }

  try {
    const market = await getMarketDataProvider().getTokenMarket(chainId, observation.tokenAddress);
    const safety = observation.side === "buy"
      ? mergeTokenSafety(evaluateTokenSafety(market), await inspectContractSecurity(chainId, observation.tokenAddress as Address))
      : evaluateTokenSafety(market);
    if (!safety.approved) {
      if (consensus?.shouldCopy) store.finishCopyBuyStage(chainId, observation.tokenAddress, consensus.stage, false);
      store.recordWalletObservation(wallet.id, "swap", false);
      await publishEvent({
        chainId,
        level: "warning",
        type: "swap",
        title: `${observation.tokenSymbol} kopyası reddedildi`,
        message: `${wallet.label} işlemi algılandı ancak ${safety.reason.toLocaleLowerCase("tr-TR")}`,
        txHash: transaction.hash,
      });
      return null;
    }

    const trade = await executePaperTrade(
      {
        chainId,
        side: observation.side,
        tokenAddress: observation.tokenAddress,
        tokenSymbol: market.tokenSymbol || observation.tokenSymbol,
        pairAddress: market.pairAddress,
        priceUsd: market.priceUsd,
        slippagePercent: 0.75,
        liquidityUsd: market.liquidityUsd,
        dexFeePercent: dexFeePercentFor(market.dexId),
        priceChange24hPercent: market.priceChange24hPercent,
      },
      context,
    );
    store.recordWalletObservation(wallet.id, "swap", trade.status === "confirmed");
    if (consensus?.shouldCopy) {
      store.finishCopyBuyStage(chainId, observation.tokenAddress, consensus.stage, trade.status === "confirmed");
    }
    if (safety.warnings.length && trade.status === "confirmed") {
      await publishEvent({
        chainId,
        level: "warning",
        type: "swap",
        title: `${observation.tokenSymbol} güvenlik notu`,
        message: safety.warnings.join(" "),
        txHash: transaction.hash,
      });
    }
    return trade;
  } catch (error) {
    if (consensus?.shouldCopy) store.finishCopyBuyStage(chainId, observation.tokenAddress, consensus.stage, false);
    store.recordWalletObservation(wallet.id, "swap", false);
    await publishEvent({
      chainId,
      level: "warning",
      type: "swap",
      title: `${observation.tokenSymbol} kopyası tamamlanamadı`,
      message: error instanceof Error ? error.message : "Piyasa verisi veya paper işlem motoru hatası.",
      txHash: transaction.hash,
    });
    return null;
  }
}
