import type { ChainAdapter, ObservedTransaction } from "@/lib/chains/chain-adapter";
import type { ChainId, EvmChainId, Trade, TrackedWallet } from "@/lib/domain/types";
import { executePaperTrade, recordSkippedPaperTrade, type PaperTradeContext } from "@/lib/engine/paper-trading";
import { dexFeePercentFor } from "@/lib/engine/paper-execution-model";
import { evaluateTokenSafety, type TokenSafetyResult } from "@/lib/engine/token-security";
import { store } from "@/lib/repositories/store";
import { publishEvent } from "@/lib/services/audit-service";
import { getMarketDataProvider } from "@/lib/services/market-data-provider";
import { inspectContractSecurity, mergeTokenSafety } from "@/lib/services/contract-security-service";
import { formatEther, formatUnits, getAddress, parseUnits, type Address } from "viem";
import { getEvmExecutionAdapter } from "@/lib/execution/evm-execution-adapter";
import { assertEvmExecutionRisk } from "@/lib/execution/live-execution-guard";
import { copyAllocationPercent, resolveOwnedBaseUnitSell } from "@/lib/execution/execution-lot-math";
import { reconcileAfterLiveExecution } from "@/lib/services/live-certification";
import { assertLiveDailyLossLimit } from "@/lib/services/live-equity";
import { isStablecoinAsset } from "@/lib/engine/stablecoin-filter";
import { solanaExecutionAdapter } from "@/lib/execution/solana-execution-adapter";
import { isEvmChain } from "@/lib/domain/defaults";
import { applyShadowBuy, applyShadowSell, assertShadowPortfolioRisk, consumedCost } from "@/lib/services/execution-accounting";
import { SOLANA_LAMPORTS_PER_SOL, SOLANA_NATIVE_MINT } from "@/lib/solana/constants";
import { assertNetworkFeeLimit } from "@/lib/execution/network-fee-guard";
import { estimateSolanaNetworkFeeLamports, estimateSolanaRouteFeeUsd } from "@/lib/execution/solana-fee";
import { assertNetworkExecutionLimit, getNetworkExecutionLimit } from "@/lib/execution/network-execution-risk";
import { assertPriceDeviation, prepareFreshQuote } from "@/lib/execution/execution-quote-guard";
import { assertAssetExecutionPolicy, liquidityAllocationMultiplier, normalizePolicyAsset } from "@/lib/engine/asset-execution-policy";
import { verifyEvmExitRoute, verifySolanaExitRoute } from "@/lib/services/exit-route-verifier";
import { claimExecutionAttempt, createCopyExecutionKey, recordExecutionFailure, runLiveSubmission } from "@/lib/services/execution-lifecycle";
import { inspectSolanaTokenSecurity } from "@/lib/services/token-quote-service";
import { isWalletEligibleForCopy } from "@/lib/engine/wallet-copy-eligibility";
import { queueTradeAdvisory } from "@/lib/services/ai-trade-advisor";

export async function processCopyableSwap(
  chainId: ChainId,
  wallet: TrackedWallet,
  transaction: ObservedTransaction,
  adapter: ChainAdapter,
  classificationReason?: string,
): Promise<Trade | null> {
  if (!isWalletEligibleForCopy(wallet.state)) return null;
  const observation = await adapter.analyzeSwap(transaction);
  if (!observation) {
    store.recordWalletObservation(wallet.id, "unknown", false);
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
  if (isStablecoinAsset(chainId, observation.tokenAddress, observation.tokenSymbol)) return null;

  const activityLimit = store.recordWalletSwapActivity(chainId, wallet.id, transaction.hash);
  if (activityLimit.exceeded) {
    if (activityLimit.newlyPaused) {
      await publishEvent({
        chainId,
        level: "warning",
        type: "system",
        title: "Yoğun işlem yapan cüzdan duraklatıldı",
        message: `${wallet.label} otomatik olarak izleme dışına alındı. ${activityLimit.reason} Bu swap kopyalanmadı; açık pozisyonlar korunuyor. Cüzdanlar sayfasından yeniden etkinleştirebilirsin.`,
        txHash: transaction.hash,
      });
    }
    return null;
  }

  await publishEvent({
    chainId,
    level: "info",
    type: "swap",
    title: "Swap değerlendirmeye alındı",
    message: `${wallet.label} cüzdanının işlemi swap olarak doğrulandı; token hareketleri ve piyasa koşulları inceleniyor.${classificationReason ? ` ${classificationReason}` : ""}`,
    txHash: transaction.hash,
  });

  const context: PaperTradeContext = {
    source: "copy",
    walletId: wallet.id,
    walletScore: wallet.score,
    sourceLabel: wallet.label,
    txHash: transaction.hash,
  };
  const mode = store.getMode();
  const consensus = observation.side === "buy"
    ? mode === "paper"
      ? store.registerCopyBuySignal(chainId, observation.tokenAddress, wallet.id, transaction.hash)
      : store.registerExecutionBuySignal(mode, chainId, observation.tokenAddress, wallet.id, transaction.hash)
    : null;
  if (consensus && !consensus.shouldCopy) {
    const reason = consensus.reason === "duplicate_wallet"
      ? `${wallet.label} bu token için daha önce sayıldığı için tekrar eden alım sinyali konsensüse eklenmedi.`
      : consensus.reason === "stage_pending"
        ? `${observation.tokenSymbol} için önceki ${mode} alım aşaması hâlâ sonuçlanıyor; çift emir engellendi.`
        : `${observation.tokenSymbol} için ${consensus.distinctWalletCount} farklı cüzdan alımı görüldü. Sonraki ${mode} alım eşiği ${consensus.requiredWalletCount} farklı cüzdan.`;
    const trade = mode === "paper" ? await recordSkippedPaperTrade({ chainId, side: observation.side, tokenAddress: observation.tokenAddress, tokenSymbol: observation.tokenSymbol, priceUsd: 0 }, reason, context) : null;
    if (mode !== "paper") await publishEvent({ chainId, level: "info", type: "swap", title: `${observation.tokenSymbol} konsensüs bekliyor`, message: reason, txHash: transaction.hash });
    store.recordWalletObservation(wallet.id, "swap", false);
    return trade;
  }
  context.allowConsensusBuy = consensus?.shouldCopy ?? false;
  const ownedExecutionLots = mode === "paper" ? [] : store.getOpenExecutionLots({ integrationId: chainId, mode, assetKey: observation.tokenAddress, walletId: wallet.id });
  const missingSellPosition = observation.side === "sell" && (mode === "paper"
    ? !store.listPositionLots(chainId, observation.tokenAddress, wallet.id).length
    : !ownedExecutionLots.length)
    ? `${observation.tokenSymbol} için bu cüzdana bağlı açık pozisyon bulunmadığından satış uygulanmadı.`
    : null;
  if (missingSellPosition) {
    const trade = mode === "paper" ? await recordSkippedPaperTrade({ chainId, side: observation.side, tokenAddress: observation.tokenAddress, tokenSymbol: observation.tokenSymbol, priceUsd: 0 }, missingSellPosition, context) : null;
    if (mode !== "paper") await publishEvent({ chainId, level: "warning", type: "swap", title: `${observation.tokenSymbol} satışı atlandı`, message: missingSellPosition, txHash: transaction.hash });
    store.recordWalletObservation(wallet.id, "swap", false);
    return trade;
  }

  try {
    const market = await getMarketDataProvider().getTokenMarket(chainId, observation.tokenAddress);
    const policy = store.getRiskSettings().assetPolicy!;
    const youngMarket = isYoungMarket(market, policy.youngPoolAgeMinutes);
    const trusted = policy.trustedAssets[chainId].some((asset) => normalizePolicyAsset(chainId, asset) === normalizePolicyAsset(chainId, observation.tokenAddress));
    const allowYoungPool = youngMarket && (trusted || (consensus?.distinctWalletCount ?? 0) >= policy.youngPoolMinWallets);
    const cautiousPumpfun = observation.side === "buy" && chainId === "solana" && isNewPumpMarket(market);
    const safety = observation.side === "buy"
      ? isEvmChain(chainId)
        ? mergeTokenSafety(evaluateTokenSafety(market, { allowYoungPool }), await inspectContractSecurity(chainId, observation.tokenAddress as Address))
        : mergeTokenSafety(evaluateTokenSafety(market, { allowYoungPool }), await inspectSolanaTokenSecurity(observation.tokenAddress))
      : evaluateTokenSafety(market, { allowYoungPool: true });
    if (!safety.approved) {
      if (consensus?.shouldCopy) {
        if (mode === "paper") store.finishCopyBuyStage(chainId, observation.tokenAddress, consensus.stage, false);
        else store.finishExecutionBuyStage(mode, chainId, observation.tokenAddress, consensus.stage, false, wallet.id);
      }
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

    if (cautiousPumpfun && (consensus?.distinctWalletCount ?? 0) < 3) {
      if (consensus?.shouldCopy) {
        if (mode === "paper") store.finishCopyBuyStage(chainId, observation.tokenAddress, consensus.stage, false);
        else store.finishExecutionBuyStage(mode, chainId, observation.tokenAddress, consensus.stage, false, wallet.id);
      }
      const reason = `${market.tokenSymbol} yeni bir Pump.fun piyasası. Temkinli alım için en az 3 farklı cüzdan sinyali bekleniyor; şu an ${consensus?.distinctWalletCount ?? 1} sinyal var.`;
      const trade = mode === "paper" ? await recordSkippedPaperTrade({ chainId, side: observation.side, tokenAddress: observation.tokenAddress, tokenSymbol: market.tokenSymbol, priceUsd: market.priceUsd }, reason, context) : null;
      store.recordWalletObservation(wallet.id, "swap", false);
      return trade;
    }
    if (cautiousPumpfun) context.allocationMultiplier = 0.5;

    queueTradeAdvisory({
      chainId,
      mode,
      side: observation.side,
      asset: market.tokenSymbol || observation.tokenSymbol,
      walletId: wallet.id,
      walletLabel: wallet.label,
      walletScore: wallet.score,
      walletConfirmations: consensus?.distinctWalletCount ?? 1,
      priceUsd: market.priceUsd,
      priceChange24hPercent: market.priceChange24hPercent,
      liquidityUsd: market.liquidityUsd,
      volume24hUsd: market.volume24hUsd,
      marketCapUsd: market.marketCapUsd,
      safetyScore: safety.score,
      safetyWarnings: safety.warnings,
      sourceReference: transaction.hash,
    });

    if (mode !== "paper") {
      if (chainId === "hyperliquid") throw new Error("HyperCore copy işlemi spot yürütücüsüne gönderilemez.");
      if (chainId === "solana") await executeSolanaCopyTrade({ wallet, transaction, observation, market, mode, consensus, safety, allocationMultiplier: context.allocationMultiplier });
      else await executeEvmCopyTrade({ chainId, wallet, transaction, observation, market, mode, consensus, safety });
      return null;
    }

    const trade = await executePaperTrade(
      {
        chainId,
        side: observation.side,
        tokenAddress: observation.tokenAddress,
        tokenSymbol: market.tokenSymbol || observation.tokenSymbol,
        tokenDecimals: observation.tokenDecimals,
        pairAddress: market.pairAddress,
        priceUsd: market.priceUsd,
        slippagePercent: 0.75,
        liquidityUsd: market.liquidityUsd,
        dexFeePercent: dexFeePercentFor(market.dexId),
        priceChange24hPercent: cautiousPumpfun ? undefined : market.priceChange24hPercent,
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
    if (consensus?.shouldCopy) {
      if (mode === "paper") store.finishCopyBuyStage(chainId, observation.tokenAddress, consensus.stage, false);
      else store.finishExecutionBuyStage(mode, chainId, observation.tokenAddress, consensus.stage, false, wallet.id);
    }
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

async function executeEvmCopyTrade(input: {
  chainId: EvmChainId;
  wallet: TrackedWallet;
  transaction: ObservedTransaction;
  observation: NonNullable<Awaited<ReturnType<ChainAdapter["analyzeSwap"]>>>;
  market: Awaited<ReturnType<ReturnType<typeof getMarketDataProvider>["getTokenMarket"]>>;
  mode: "shadow" | "live";
  consensus: ReturnType<typeof store.registerExecutionBuySignal> | null;
  safety: TokenSafetyResult;
}) {
  const requestId = `copy:${input.mode}:${input.chainId}:${input.transaction.hash.toLowerCase()}`;
  const idempotencyKey = createCopyExecutionKey(input.mode, input.chainId, input.transaction.hash);
  const settings = store.getRiskSettings();
  const networkLimit = getNetworkExecutionLimit(input.chainId, settings);
  const youngAllocationMultiplier = input.observation.side === "buy" && isYoungMarket(input.market, settings.assetPolicy!.youngPoolAgeMinutes)
    ? settings.assetPolicy!.youngPoolAllocationMultiplier
    : 1;
  const allocationPercent = copyAllocationPercent(input.wallet.score, networkLimit.minPositionPercent, networkLimit.maxPositionPercent)
    * Math.min(youngAllocationMultiplier, liquidityAllocationMultiplier(input.market.liquidityUsd, settings.minimumLiquidityUsd));
  const ownedLots = store.getOpenExecutionLots({ integrationId: input.chainId, mode: input.mode, assetKey: input.observation.tokenAddress, walletId: input.wallet.id });
  const observedAmount = tokenAmountToBaseUnits(input.observation.tokenAmount, input.observation.tokenDecimals);
  const exactSellAmount = input.observation.side === "sell" ? resolveOwnedBaseUnitSell(observedAmount, ownedLots.map((lot) => lot.amount)) : undefined;
  if (input.observation.side === "sell" && (!exactSellAmount || exactSellAmount <= 0n)) throw new Error("Kaynak cüzdana ait satılabilir execution lotu yok.");

  const claim = claimExecutionAttempt({ requestId, idempotencyKey, integrationId: input.chainId, walletId: input.wallet.id, mode: input.mode, source: "copy", action: input.observation.side, asset: input.observation.tokenSymbol });
  if (!claim.created) return;
  try {
    const adapter = getEvmExecutionAdapter(input.chainId);
    const intent = {
      chainId: input.chainId,
      side: input.observation.side,
      tokenAddress: getAddress(input.observation.tokenAddress),
      allocationPercent,
      exactSellAmount,
      slippagePercent: Math.min(0.75, networkLimit.maxSlippagePercent),
      mode: input.mode,
    } as const;
    const prepared = await prepareFreshQuote({ chainId: input.chainId, settings, prepare: () => adapter.prepare(intent), quotedAt: (current) => current.quotedAt });
    const plan = prepared.plan;
    const assetPolicy = assertAssetExecutionPolicy({
      chainId: input.chainId,
      asset: input.observation.tokenAddress,
      opensPosition: input.observation.side === "buy",
      settings,
      safety: input.safety,
      market: input.market,
      walletConfirmations: input.consensus?.distinctWalletCount ?? 0,
      walletScore: input.wallet.score,
      exitRouteVerified: input.observation.side === "buy" ? await verifyEvmExitRoute(plan) : true,
    });
    const risk = await assertEvmExecutionRisk({ chainId: input.chainId, plan, settings });
    const quotedTokenQuantity = Number(formatUnits(input.observation.side === "buy" ? plan.buyAmount : plan.sellAmount, input.observation.tokenDecimals));
    const quoteGuard = assertPriceDeviation({ chainId: input.chainId, side: input.observation.side, referencePriceUsd: input.market.priceUsd, quotedPriceUsd: quotedTokenQuantity > 0 ? risk.estimatedTradeUsd / quotedTokenQuantity : 0, quotedAt: plan.quotedAt, quoteRefreshed: prepared.quoteRefreshed, settings });
    const dexFeeUsd = risk.estimatedTradeUsd * dexFeePercentFor(input.market.dexId) / 100 + ("providerFeeUsd" in plan ? plan.providerFeeUsd : 0);
    assertNetworkExecutionLimit({ chainId: input.chainId, tradeUsd: risk.estimatedTradeUsd, slippagePercent: Math.min(0.75, networkLimit.maxSlippagePercent), side: input.observation.side, settings });
    assertNetworkFeeLimit({ chainId: input.chainId, tradeUsd: risk.estimatedTradeUsd, networkFeeUsd: risk.gasFeeUsd, venueFeeUsd: dexFeeUsd, settings });
    if (input.mode === "shadow") {
      await assertShadowPortfolioRisk({ chainId: input.chainId, assetKey: input.observation.tokenAddress, walletId: input.wallet.id, side: input.observation.side, estimatedTradeUsd: risk.estimatedTradeUsd });
    }
    if (input.mode === "live") await assertLiveDailyLossLimit(input.chainId, { assetKey: input.observation.tokenAddress, walletId: input.wallet.id, side: input.observation.side, estimatedTradeUsd: risk.estimatedTradeUsd });
    const simulationStartedAt = performance.now();
    const execution = input.mode === "shadow" ? await adapter.simulate(plan) : await runLiveSubmission(requestId, (hooks) => adapter.execute(plan, hooks));
    const simulationLatencyMs = Math.round(performance.now() - simulationStartedAt);
    const executedAmount = BigInt(execution.executedAmount);
    const receivedAmount = BigInt(execution.receivedAmount);
    const networkFeeUsd = execution.networkFeeNativeAmount
      ? Number(formatEther(BigInt(execution.networkFeeNativeAmount))) * risk.nativePriceUsd
      : risk.gasFeeUsd;
    const tokenQuantity = input.observation.side === "buy"
      ? Number(formatUnits(receivedAmount, input.observation.tokenDecimals))
      : Number(formatUnits(executedAmount, input.observation.tokenDecimals));
    const quotedPriceUsd = tokenQuantity > 0 ? risk.estimatedTradeUsd / tokenQuantity : input.market.priceUsd;
    const priceImpactPercent = input.market.priceUsd > 0 ? Math.abs(quotedPriceUsd / input.market.priceUsd - 1) * 100 : 0;
    store.updateExecutionAttempt(requestId, {
      status: input.mode === "shadow" ? "simulated" : "confirmed", amountIn: executedAmount, amountOut: receivedAmount,
      expectedAmountOut: plan.buyAmount.toString(), minimumAmountOut: plan.minBuyAmount.toString(),
      quotedPriceUsd, slippagePercent: Math.min(0.75, networkLimit.maxSlippagePercent), priceImpactPercent,
      networkFeeUsd, dexFeeUsd, availableBalanceUsd: input.mode === "shadow" ? store.getShadowAccount(input.chainId)?.cashBalanceUsd ?? 0 : 0,
      simulationLatencyMs, metadata: {
        ...quoteGuard,
        assetPolicy,
        executionProvider: "provider" in plan ? plan.provider : "uniswap-v4",
        routeTool: "routeTool" in plan ? plan.routeTool : null,
        target: plan.transaction.to,
        nativePriceUsd: risk.nativePriceUsd,
        actualNetworkFeeNativeAmount: execution.networkFeeNativeAmount ?? null,
        estimatedNetworkFeeUsd: risk.gasFeeUsd,
      },
      txHash: execution.txHash,
      externalOrderId: execution.externalOrderId,
    });
    if (input.observation.side === "buy") {
      const now = new Date().toISOString();
      const entryCostUsd = risk.estimatedTradeUsd + networkFeeUsd;
      store.insertExecutionLot({
        id: crypto.randomUUID(), integrationId: input.chainId, mode: input.mode, assetKey: input.observation.tokenAddress,
        walletId: input.wallet.id, source: "copy", marketType: "evm", positionSide: null,
        amount: receivedAmount.toString(), amountFormat: "base_units", entryReference: execution.txHash ?? input.transaction.hash,
        assetSymbol: input.market.tokenSymbol || input.observation.tokenSymbol, assetDecimals: input.observation.tokenDecimals,
        entryPriceUsd: tokenQuantity > 0 ? entryCostUsd / tokenQuantity : quotedPriceUsd, currentPriceUsd: input.market.priceUsd,
        entryCostUsd, feesUsd: networkFeeUsd + dexFeeUsd,
        status: "open", openedAt: now, updatedAt: now,
      });
      if (input.mode === "shadow") applyShadowBuy(input.chainId, entryCostUsd, networkFeeUsd + dexFeeUsd);
      if (input.consensus?.shouldCopy) store.finishExecutionBuyStage(input.mode, input.chainId, input.observation.tokenAddress, input.consensus.stage, true);
    } else {
      const netProceedsUsd = Math.max(0, Number(formatEther(receivedAmount)) * risk.nativePriceUsd - networkFeeUsd);
      const costBasisUsd = consumedCost(ownedLots, executedAmount.toString());
      store.reduceExecutionLots(ownedLots, executedAmount.toString(), { netProceedsUsd, feesUsd: networkFeeUsd + dexFeeUsd });
      if (input.mode === "shadow") applyShadowSell(input.chainId, netProceedsUsd, netProceedsUsd - costBasisUsd, networkFeeUsd + dexFeeUsd);
    }
    store.markExecutionAccounted(requestId);
    if (input.mode === "live") await reconcileAfterLiveExecution(input.chainId, requestId);
    store.recordWalletObservation(input.wallet.id, "swap", true);
    await publishEvent({
      chainId: input.chainId,
      level: "info",
      type: "swap",
      title: `${input.observation.tokenSymbol} ${input.mode} copy trade tamamlandı`,
      message: `${input.wallet.label} kaynaklı ${input.observation.side === "buy" ? "alım" : "satış"} ${input.mode === "live" ? "zincirde onaylandı" : "imzalanmadan simüle edildi"}. Lot sahipliği bu cüzdana kaydedildi.`,
      txHash: execution.txHash ?? input.transaction.hash,
    });
  } catch (error) {
    recordExecutionFailure(requestId, error);
    throw error;
  }
}

async function executeSolanaCopyTrade(input: {
  wallet: TrackedWallet;
  transaction: ObservedTransaction;
  observation: NonNullable<Awaited<ReturnType<ChainAdapter["analyzeSwap"]>>>;
  market: Awaited<ReturnType<ReturnType<typeof getMarketDataProvider>["getTokenMarket"]>>;
  mode: "shadow" | "live";
  consensus: ReturnType<typeof store.registerExecutionBuySignal> | null;
  safety: TokenSafetyResult;
  allocationMultiplier?: number;
}) {
  const chainId = "solana" as const;
  const requestId = `copy:${input.mode}:${chainId}:${input.transaction.hash}`;
  const idempotencyKey = createCopyExecutionKey(input.mode, chainId, input.transaction.hash);
  const settings = store.getRiskSettings();
  const networkLimit = getNetworkExecutionLimit(chainId, settings);
  const youngAllocationMultiplier = input.observation.side === "buy" && isYoungMarket(input.market, settings.assetPolicy!.youngPoolAgeMinutes)
    ? settings.assetPolicy!.youngPoolAllocationMultiplier
    : 1;
  const allocationPercent = copyAllocationPercent(input.wallet.score, networkLimit.minPositionPercent, networkLimit.maxPositionPercent)
    * Math.min(input.allocationMultiplier ?? 1, youngAllocationMultiplier, liquidityAllocationMultiplier(input.market.liquidityUsd, settings.minimumLiquidityUsd));
  const ownedLots = store.getOpenExecutionLots({ integrationId: chainId, mode: input.mode, assetKey: input.observation.tokenAddress, walletId: input.wallet.id });
  const observedAmount = tokenAmountToBaseUnits(input.observation.tokenAmount, input.observation.tokenDecimals);
  const exactSellAmount = input.observation.side === "sell" ? resolveOwnedBaseUnitSell(observedAmount, ownedLots.map((lot) => lot.amount)) : undefined;
  if (input.observation.side === "sell" && (!exactSellAmount || exactSellAmount <= 0n)) throw new Error("Kaynak cüzdana ait satılabilir Solana lotu yok.");
  const claim = claimExecutionAttempt({ requestId, idempotencyKey, integrationId: chainId, walletId: input.wallet.id, mode: input.mode, source: "copy", action: input.observation.side, asset: input.observation.tokenSymbol });
  if (!claim.created) return;
  try {
    const intent = { side: input.observation.side, tokenAddress: input.observation.tokenAddress, allocationPercent, exactSellAmount, slippagePercent: Math.min(0.75, networkLimit.maxSlippagePercent), mode: input.mode } as const;
    const prepared = await prepareFreshQuote({ chainId, settings, prepare: () => solanaExecutionAdapter.prepare(intent), quotedAt: (current) => current.quotedAt });
    const plan = prepared.plan;
    const assetPolicy = assertAssetExecutionPolicy({
      chainId,
      asset: input.observation.tokenAddress,
      opensPosition: input.observation.side === "buy",
      settings,
      safety: input.safety,
      market: input.market,
      walletConfirmations: input.consensus?.distinctWalletCount ?? 0,
      walletScore: input.wallet.score,
      exitRouteVerified: input.observation.side === "buy" ? await verifySolanaExitRoute(plan) : true,
    });
    const nativeMarket = await getMarketDataProvider().getTokenMarket(chainId, SOLANA_NATIVE_MINT);
    const tradeUsd = input.observation.side === "buy"
      ? Number(plan.quote.inAmount) / SOLANA_LAMPORTS_PER_SOL * nativeMarket.priceUsd
      : Number(plan.quote.outAmount) / SOLANA_LAMPORTS_PER_SOL * nativeMarket.priceUsd;
    assertSolanaExecutionRisk(plan, settings, tradeUsd);
    const estimatedNetworkFeeUsd = estimateSolanaNetworkFeeLamports(plan.estimatedPriorityFeeLamports) / SOLANA_LAMPORTS_PER_SOL * nativeMarket.priceUsd;
    const dexFeeUsd = estimateSolanaRouteFeeUsd(plan.quote, nativeMarket.priceUsd, input.market.priceUsd, input.observation.tokenDecimals);
    const quotedTokenQuantity = Number(formatUnits(BigInt(input.observation.side === "buy" ? plan.quote.outAmount : plan.quote.inAmount), input.observation.tokenDecimals));
    const quoteGuard = assertPriceDeviation({ chainId, side: input.observation.side, referencePriceUsd: input.market.priceUsd, quotedPriceUsd: quotedTokenQuantity > 0 ? tradeUsd / quotedTokenQuantity : 0, quotedAt: plan.quotedAt, quoteRefreshed: prepared.quoteRefreshed, settings });
    assertNetworkExecutionLimit({ chainId, tradeUsd, slippagePercent: plan.quote.slippageBps / 100, side: input.observation.side, settings });
    assertNetworkFeeLimit({ chainId, tradeUsd, networkFeeUsd: estimatedNetworkFeeUsd, venueFeeUsd: dexFeeUsd, settings });
    if (input.mode === "shadow") await assertShadowPortfolioRisk({ chainId, assetKey: input.observation.tokenAddress, walletId: input.wallet.id, side: input.observation.side, estimatedTradeUsd: tradeUsd });
    if (input.mode === "live") await assertLiveDailyLossLimit(chainId, { assetKey: input.observation.tokenAddress, walletId: input.wallet.id, side: input.observation.side, estimatedTradeUsd: tradeUsd });
    const simulationStartedAt = performance.now();
    const execution = input.mode === "shadow" ? await solanaExecutionAdapter.simulate(plan) : await runLiveSubmission(requestId, (hooks) => solanaExecutionAdapter.execute(plan, hooks));
    const simulationLatencyMs = Math.round(performance.now() - simulationStartedAt);
    const actualNetworkFeeLamports = execution.networkFeeNativeAmount ? Number(execution.networkFeeNativeAmount) : null;
    const refundableRentLamports = execution.refundableRentNativeAmount ? Number(execution.refundableRentNativeAmount) : 0;
    const networkFeeUsd = actualNetworkFeeLamports === null
      ? estimatedNetworkFeeUsd
      : actualNetworkFeeLamports / SOLANA_LAMPORTS_PER_SOL * nativeMarket.priceUsd;
    const amountIn = BigInt(execution.executedAmount);
    const amountOut = BigInt(execution.receivedAmount);
    const tokenQuantity = input.observation.side === "buy" ? Number(formatUnits(amountOut, input.observation.tokenDecimals)) : Number(formatUnits(amountIn, input.observation.tokenDecimals));
    const quotedPriceUsd = tokenQuantity > 0 ? tradeUsd / tokenQuantity : input.market.priceUsd;
    const priceImpactPercent = Number(plan.quote.priceImpactPct) * 100;
    store.updateExecutionAttempt(requestId, {
      status: input.mode === "shadow" ? "simulated" : "confirmed", amountIn, amountOut,
      expectedAmountOut: plan.quote.outAmount, minimumAmountOut: plan.quote.otherAmountThreshold,
      quotedPriceUsd, slippagePercent: plan.quote.slippageBps / 100, priceImpactPercent,
      networkFeeUsd, dexFeeUsd, availableBalanceUsd: input.mode === "shadow" ? store.getShadowAccount(chainId)?.cashBalanceUsd ?? 0 : 0,
      simulationLatencyMs, metadata: { ...quoteGuard, assetPolicy, tradeValueUsd: tradeUsd, estimatedNetworkFeeUsd, actualNetworkFeeLamports, refundableRentLamports, refundableRentDepositUsd: refundableRentLamports / SOLANA_LAMPORTS_PER_SOL * nativeMarket.priceUsd, contextSlot: plan.quote.contextSlot, computeUnitLimit: plan.transaction.computeUnitLimit, shadowSimulation: plan.shadowSimulation },
      txHash: execution.txHash,
      externalOrderId: execution.externalOrderId,
    });
    if (input.observation.side === "buy") {
      const now = new Date().toISOString();
      const entryCostUsd = tradeUsd + networkFeeUsd;
      store.insertExecutionLot({
        id: crypto.randomUUID(), integrationId: chainId, mode: input.mode, assetKey: input.observation.tokenAddress,
        walletId: input.wallet.id, source: "copy", marketType: "solana", positionSide: null,
        amount: amountOut.toString(), amountFormat: "base_units", entryReference: execution.txHash ?? input.transaction.hash,
        assetSymbol: input.market.tokenSymbol || input.observation.tokenSymbol, assetDecimals: input.observation.tokenDecimals,
        entryPriceUsd: tokenQuantity > 0 ? entryCostUsd / tokenQuantity : quotedPriceUsd, currentPriceUsd: input.market.priceUsd,
        entryCostUsd, feesUsd: networkFeeUsd + dexFeeUsd, status: "open", openedAt: now, updatedAt: now,
      });
      if (input.mode === "shadow") applyShadowBuy(chainId, entryCostUsd, networkFeeUsd + dexFeeUsd);
      if (input.consensus?.shouldCopy) store.finishExecutionBuyStage(input.mode, chainId, input.observation.tokenAddress, input.consensus.stage, true);
    } else {
      const netProceedsUsd = Math.max(0, Number(amountOut) / SOLANA_LAMPORTS_PER_SOL * nativeMarket.priceUsd - networkFeeUsd);
      const costBasisUsd = consumedCost(ownedLots, amountIn.toString());
      store.reduceExecutionLots(ownedLots, amountIn.toString(), { netProceedsUsd, feesUsd: networkFeeUsd + dexFeeUsd });
      if (input.mode === "shadow") applyShadowSell(chainId, netProceedsUsd, netProceedsUsd - costBasisUsd, networkFeeUsd + dexFeeUsd);
    }
    store.markExecutionAccounted(requestId);
    if (input.mode === "live") await reconcileAfterLiveExecution(chainId, requestId);
    store.recordWalletObservation(input.wallet.id, "swap", true);
    await publishEvent({ chainId, level: "info", type: "swap", title: `${input.market.tokenSymbol} ${input.mode} Solana copy trade tamamlandı`, message: `${input.wallet.label} kaynaklı spot ${input.observation.side === "buy" ? "alım" : "satış"} Jupiter rotasıyla ${input.mode === "live" ? "zincirde onaylandı" : "imzalanmadan simüle edildi"}.`, txHash: execution.txHash ?? input.transaction.hash });
  } catch (error) {
    recordExecutionFailure(requestId, error);
    throw error;
  }
}

function assertSolanaExecutionRisk(plan: Awaited<ReturnType<typeof solanaExecutionAdapter.prepare>>, settings: ReturnType<typeof store.getRiskSettings>, estimatedTradeUsd?: number) {
  const networkLimit = getNetworkExecutionLimit("solana", settings);
  if (Number(plan.quote.priceImpactPct) * 100 > settings.maxPriceImpactPercent) throw new Error("Jupiter rota fiyat etkisi risk sınırını aşıyor.");
  if (plan.quote.slippageBps / 100 > networkLimit.maxSlippagePercent) throw new Error("Jupiter slippage ayarı risk sınırını aşıyor.");
  if (plan.side === "buy" && estimatedTradeUsd && estimatedTradeUsd > networkLimit.maxTradeUsd) throw new Error("Solana işlem değeri canlı işlem tavanını aşıyor.");
}

function isNewPumpMarket(market: { dexId: string; pairCreatedAt: number | null }) {
  const ageMs = market.pairCreatedAt ? Date.now() - market.pairCreatedAt : Number.POSITIVE_INFINITY;
  return /pump/i.test(market.dexId) && ageMs >= 0 && ageMs < 6 * 60 * 60_000;
}

function isYoungMarket(market: { pairCreatedAt: number | null }, maxAgeMinutes: number) {
  const ageMs = market.pairCreatedAt ? Date.now() - market.pairCreatedAt : Number.POSITIVE_INFINITY;
  return ageMs >= 0 && ageMs < maxAgeMinutes * 60_000;
}

function tokenAmountToBaseUnits(amount: number, decimals: number) {
  const safeDecimals = Math.max(0, Math.min(24, decimals));
  const value = amount.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: safeDecimals });
  return parseUnits(value, decimals);
}
