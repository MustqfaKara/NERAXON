import { NextResponse } from "next/server";
import { formatEther, formatUnits, getAddress, isAddress } from "viem";
import { z } from "zod";
import { executePaperTrade } from "@/lib/engine/paper-trading";
import { dexFeePercentFor } from "@/lib/engine/paper-execution-model";
import { store } from "@/lib/repositories/store";
import { resolveTokenQuote } from "@/lib/services/token-quote-service";
import { apiError } from "@/lib/utils/api";
import { assertSameOrigin } from "@/lib/security/same-origin";
import { getEvmExecutionAdapter } from "@/lib/execution/evm-execution-adapter";
import { assertEvmExecutionRisk } from "@/lib/execution/live-execution-guard";
import { publishEvent } from "@/lib/services/audit-service";
import { reconcileAfterLiveExecution } from "@/lib/services/live-certification";
import { assertLiveDailyLossLimit } from "@/lib/services/live-equity";
import { PublicKey } from "@solana/web3.js";
import { solanaExecutionAdapter } from "@/lib/execution/solana-execution-adapter";
import type { ExecutionAttempt } from "@/lib/domain/types";
import { applyShadowBuy, applyShadowSell, assertShadowPortfolioRisk, consumedCost } from "@/lib/services/execution-accounting";
import { getMarketDataProvider } from "@/lib/services/market-data-provider";
import { SOLANA_LAMPORTS_PER_SOL, SOLANA_NATIVE_MINT } from "@/lib/solana/constants";
import { assertNetworkFeeLimit } from "@/lib/execution/network-fee-guard";
import { estimateSolanaNetworkFeeLamports, estimateSolanaRouteFeeUsd } from "@/lib/execution/solana-fee";
import { assertNetworkExecutionLimit, getNetworkExecutionLimit } from "@/lib/execution/network-execution-risk";
import { assertPriceDeviation, prepareFreshQuote } from "@/lib/execution/execution-quote-guard";
import { publishEmergencyExitDeviation } from "@/lib/services/emergency-exit-notification";
import { assertAssetExecutionPolicy } from "@/lib/engine/asset-execution-policy";
import { verifyEvmExitRoute, verifySolanaExitRoute } from "@/lib/services/exit-route-verifier";
import { claimExecutionAttempt, createManualExecutionKey, recordExecutionFailure, runLiveSubmission } from "@/lib/services/execution-lifecycle";

const schema = z.object({
  chainId: z.enum(["ethereum", "base", "robinhood", "solana"]),
  side: z.enum(["buy", "sell"]),
  tokenAddress: z.string().trim().min(1),
  allocationPercent: z.coerce.number().min(0.1).max(100).optional(),
  sellPercent: z.coerce.number().min(1).max(100).optional(),
  quantity: z.coerce.number().positive().optional(),
  slippagePercent: z.coerce.number().min(0).max(20).optional(),
  requestId: z.string().uuid().optional(),
});

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = schema.parse(await request.json());
    if (input.chainId === "solana") {
      try { new PublicKey(input.tokenAddress); } catch { throw new Error("Geçerli bir Solana token mint adresi girin."); }
    } else if (!isAddress(input.tokenAddress.toLowerCase())) throw new Error("Geçerli bir token kontrat adresi girin.");
    const position = input.side === "sell" ? store.getPosition(input.chainId, input.tokenAddress) : null;
    let quote: Awaited<ReturnType<typeof resolveTokenQuote>> | null = null;

    try {
      quote = await resolveTokenQuote(input.chainId, input.tokenAddress);
    } catch (error) {
      if (!position || position.currentPriceUsd <= 0) throw error;
    }

    if (input.side === "buy" && (!quote || !quote.safety.approved)) {
      throw new Error(quote?.safety.reason ?? "Token piyasa verileri doğrulanamadı.");
    }

    const mode = store.getMode();
    if (mode !== "paper") {
      if (input.chainId === "solana") return executeSolanaManual(input, quote, position, mode);
      const requestId = input.requestId ?? crypto.randomUUID();
      const idempotencyKey = createManualExecutionKey({ mode, chainId: input.chainId, action: input.side, asset: input.tokenAddress, allocationPercent: input.allocationPercent, closePercent: input.sellPercent, slippagePercent: input.slippagePercent });
      const claim = claimExecutionAttempt({ requestId, idempotencyKey, integrationId: input.chainId, mode, source: "manual", action: input.side, asset: quote?.symbol ?? position?.tokenSymbol ?? input.tokenAddress });
      if (!claim.created) return NextResponse.json({ execution: serializeAttempt(claim.attempt), duplicate: true });
      try {
        const evmChainId = input.chainId as "ethereum" | "base" | "robinhood";
        const settings = store.getRiskSettings();
        const networkLimit = getNetworkExecutionLimit(evmChainId, settings);
        if (input.side === "buy" && (input.allocationPercent ?? networkLimit.minPositionPercent) > networkLimit.maxPositionPercent) throw new Error("Pozisyon oranı ağ sınırını aşıyor.");
        if ((input.slippagePercent ?? 0.5) > networkLimit.maxSlippagePercent) throw new Error("Slippage oranı ağ sınırını aşıyor.");
        const adapter = getEvmExecutionAdapter(evmChainId);
        const openLots = store.getOpenExecutionLots({ integrationId: input.chainId, mode, assetKey: input.tokenAddress });
        const trackedAmount = openLots.reduce((sum, lot) => sum + BigInt(lot.amount), 0n);
        const exactSellAmount = input.side === "sell" ? trackedAmount * BigInt(Math.round(input.sellPercent ?? 100)) / 100n : undefined;
        if (input.side === "sell" && (!exactSellAmount || exactSellAmount <= 0n)) throw new Error("Seçilen token için açık shadow/live lotu bulunamadı.");
        const intent = { ...input, chainId: evmChainId, tokenAddress: getAddress(input.tokenAddress), exactSellAmount, slippagePercent: input.slippagePercent ?? 0.5, mode } as const;
        const prepared = await prepareFreshQuote({ chainId: evmChainId, settings, prepare: () => adapter.prepare(intent), quotedAt: (current) => current.quotedAt });
        const plan = prepared.plan;
        const isYoungMarket = Boolean(quote?.market.pairCreatedAt && Date.now() - quote.market.pairCreatedAt < settings.assetPolicy!.youngPoolAgeMinutes * 60_000);
        const assetPolicy = assertAssetExecutionPolicy({
          chainId: input.chainId,
          asset: input.tokenAddress,
          opensPosition: input.side === "buy",
          settings,
          safety: quote?.safety,
          market: quote?.market,
          walletConfirmations: 0,
          exitRouteVerified: input.side === "buy" && isYoungMarket ? await verifyEvmExitRoute(plan) : true,
        });
        const risk = await assertEvmExecutionRisk({ chainId: input.chainId, plan, settings });
        const quoteDecimals = quote?.decimals ?? 18;
        const quotedTokenQuantity = Number(formatUnits(input.side === "buy" ? plan.buyAmount : plan.sellAmount, quoteDecimals));
        const referencePriceUsd = quote?.market.priceUsd ?? position?.currentPriceUsd ?? 0;
        const quoteGuard = assertPriceDeviation({ chainId: evmChainId, side: input.side, referencePriceUsd, quotedPriceUsd: quotedTokenQuantity > 0 ? risk.estimatedTradeUsd / quotedTokenQuantity : 0, quotedAt: plan.quotedAt, quoteRefreshed: prepared.quoteRefreshed, emergencyExit: input.side === "sell" && (input.sellPercent ?? 100) === 100, settings });
        const dexFeeUsd = risk.estimatedTradeUsd * dexFeePercentFor(quote?.market.dexId) / 100;
        assertNetworkExecutionLimit({ chainId: input.chainId, tradeUsd: risk.estimatedTradeUsd, slippagePercent: input.slippagePercent ?? 0.5, side: input.side, settings });
        assertNetworkFeeLimit({
          chainId: input.chainId,
          tradeUsd: risk.estimatedTradeUsd,
          networkFeeUsd: risk.gasFeeUsd,
          venueFeeUsd: dexFeeUsd,
          emergencyExit: input.side === "sell" && (input.sellPercent ?? 100) === 100,
          settings,
        });
        if (mode === "shadow") await assertShadowPortfolioRisk({
          chainId: input.chainId, assetKey: input.tokenAddress, walletId: null, side: input.side, estimatedTradeUsd: risk.estimatedTradeUsd,
        });
        if (mode === "live") await assertLiveDailyLossLimit(input.chainId, { assetKey: input.tokenAddress, walletId: null, side: input.side, estimatedTradeUsd: risk.estimatedTradeUsd });
        const simulationStartedAt = performance.now();
        const execution = mode === "shadow" ? await adapter.simulate(plan) : await runLiveSubmission(requestId, (hooks) => adapter.execute(plan, hooks));
        const simulationLatencyMs = Math.round(performance.now() - simulationStartedAt);
        const amountIn = BigInt(execution.executedAmount);
        const amountOut = BigInt(execution.receivedAmount);
        const tokenDecimals = quoteDecimals;
        const tokenQuantity = input.side === "buy" ? Number(formatUnits(amountOut, tokenDecimals)) : Number(formatUnits(amountIn, tokenDecimals));
        const marketPriceUsd = quote?.market.priceUsd ?? position?.currentPriceUsd ?? 0;
        const quotedPriceUsd = tokenQuantity > 0 ? risk.estimatedTradeUsd / tokenQuantity : marketPriceUsd;
        const priceImpactPercent = marketPriceUsd > 0 ? Math.abs(quotedPriceUsd / marketPriceUsd - 1) * 100 : 0;
        store.updateExecutionAttempt(requestId, {
          status: mode === "shadow" ? "simulated" : "confirmed", amountIn, amountOut,
          expectedAmountOut: plan.buyAmount.toString(), minimumAmountOut: plan.minBuyAmount.toString(),
          quotedPriceUsd, slippagePercent: input.slippagePercent ?? 0.5, priceImpactPercent,
          networkFeeUsd: risk.gasFeeUsd, dexFeeUsd, availableBalanceUsd: mode === "shadow" ? store.getShadowAccount(input.chainId)?.cashBalanceUsd ?? 0 : 0,
          simulationLatencyMs, metadata: { ...quoteGuard, assetPolicy, target: plan.transaction.to },
          txHash: execution.txHash,
          externalOrderId: execution.externalOrderId,
        });
        if (input.side === "buy") {
          const now = new Date().toISOString();
          const entryCostUsd = risk.estimatedTradeUsd + risk.gasFeeUsd;
          store.insertExecutionLot({
            id: crypto.randomUUID(), integrationId: input.chainId, mode, assetKey: input.tokenAddress,
            walletId: null, source: "manual", marketType: "evm", positionSide: null,
            amount: amountOut.toString(), amountFormat: "base_units", entryReference: execution.txHash,
            assetSymbol: quote?.symbol ?? position?.tokenSymbol ?? "TOKEN", assetDecimals: tokenDecimals,
            entryPriceUsd: tokenQuantity > 0 ? entryCostUsd / tokenQuantity : quotedPriceUsd,
            currentPriceUsd: marketPriceUsd, entryCostUsd, feesUsd: risk.gasFeeUsd + dexFeeUsd,
            status: "open", openedAt: now, updatedAt: now,
          });
          if (mode === "shadow") applyShadowBuy(input.chainId, entryCostUsd, risk.gasFeeUsd + dexFeeUsd);
        } else {
          const netProceedsUsd = Math.max(0, Number(formatEther(amountOut)) * risk.nativePriceUsd - risk.gasFeeUsd);
          const costBasisUsd = consumedCost(openLots, amountIn.toString());
          store.reduceExecutionLots(openLots, amountIn.toString(), { netProceedsUsd, feesUsd: risk.gasFeeUsd + dexFeeUsd });
          if (mode === "shadow") applyShadowSell(input.chainId, netProceedsUsd, netProceedsUsd - costBasisUsd, risk.gasFeeUsd + dexFeeUsd);
        }
        store.markExecutionAccounted(requestId);
        if (mode === "live") await reconcileAfterLiveExecution(input.chainId, requestId);
        await publishEmergencyExitDeviation({ chainId: input.chainId, asset: quote?.symbol ?? position?.tokenSymbol ?? input.tokenAddress, assessment: quoteGuard, settings, txHash: execution.txHash });
        await publishEvent({
          chainId: input.chainId,
          level: "info",
          type: "swap",
          title: mode === "live" ? "Canlı manuel swap tamamlandı" : "Shadow swap simülasyonu tamamlandı",
          message: `${quote?.symbol ?? position?.tokenSymbol ?? "Token"} ${input.side === "buy" ? "alım" : "satım"} emri ${mode === "live" ? "zincirde onaylandı" : "imzalanmadan simüle edildi"}.`,
          txHash: execution.txHash,
        });
        return NextResponse.json({ execution: { requestId, mode, status: execution.status, txHash: execution.txHash, amountIn: amountIn.toString(), amountOut: amountOut.toString() } });
      } catch (error) {
        recordExecutionFailure(requestId, error);
        throw error;
      }
    }

    const trade = await executePaperTrade({
      ...input,
      tokenAddress: quote?.address ?? position!.tokenAddress,
      tokenSymbol: quote?.symbol ?? position!.tokenSymbol,
      tokenDecimals: quote?.decimals,
      pairAddress: quote?.market.pairAddress ?? position!.pairAddress ?? null,
      priceUsd: quote?.market.priceUsd ?? position!.currentPriceUsd,
      liquidityUsd: quote?.market.liquidityUsd,
      gasFeeUsd: quote?.gas.feeUsd,
      dexFeePercent: dexFeePercentFor(quote?.market.dexId),
      priceChange24hPercent: quote?.market.priceChange24hPercent,
    });
    return NextResponse.json({ trade }, { status: trade.status === "skipped" ? 422 : 201 });
  } catch (error) {
    return apiError(error);
  }
}

async function executeSolanaManual(
  input: z.infer<typeof schema>,
  quote: Awaited<ReturnType<typeof resolveTokenQuote>> | null,
  position: ReturnType<typeof store.getPosition>,
  mode: "shadow" | "live",
) {
  const requestId = input.requestId ?? crypto.randomUUID();
  const idempotencyKey = createManualExecutionKey({ mode, chainId: "solana", action: input.side, asset: input.tokenAddress, allocationPercent: input.allocationPercent, closePercent: input.sellPercent, slippagePercent: input.slippagePercent });
  const claim = claimExecutionAttempt({ requestId, idempotencyKey, integrationId: "solana", mode, source: "manual", action: input.side, asset: quote?.symbol ?? position?.tokenSymbol ?? input.tokenAddress });
  if (!claim.created) return NextResponse.json({ execution: serializeAttempt(claim.attempt), duplicate: true });
  try {
    const openLots = store.getOpenExecutionLots({ integrationId: "solana", mode, assetKey: input.tokenAddress });
    const trackedAmount = openLots.reduce((sum, lot) => sum + BigInt(lot.amount), 0n);
    const exactSellAmount = input.side === "sell" ? trackedAmount * BigInt(Math.round(input.sellPercent ?? 100)) / 100n : undefined;
    if (input.side === "sell" && (!exactSellAmount || exactSellAmount <= 0n)) throw new Error("Seçilen Solana tokenı için açık shadow/live lotu bulunamadı.");
    const settings = store.getRiskSettings();
    const networkLimit = getNetworkExecutionLimit("solana", settings);
    if (input.side === "buy" && (input.allocationPercent ?? networkLimit.minPositionPercent) > networkLimit.maxPositionPercent) throw new Error("Pozisyon oranı Solana ağ sınırını aşıyor.");
    if ((input.slippagePercent ?? 0.5) > networkLimit.maxSlippagePercent) throw new Error("Slippage oranı Solana ağ sınırını aşıyor.");
    const intent = { side: input.side, tokenAddress: input.tokenAddress, allocationPercent: input.allocationPercent, exactSellAmount, slippagePercent: input.slippagePercent ?? 0.5, mode } as const;
    const prepared = await prepareFreshQuote({ chainId: "solana", settings, prepare: () => solanaExecutionAdapter.prepare(intent), quotedAt: (current) => current.quotedAt });
    const plan = prepared.plan;
    const isYoungMarket = Boolean(quote?.market.pairCreatedAt && Date.now() - quote.market.pairCreatedAt < settings.assetPolicy!.youngPoolAgeMinutes * 60_000);
    const assetPolicy = assertAssetExecutionPolicy({
      chainId: "solana",
      asset: input.tokenAddress,
      opensPosition: input.side === "buy",
      settings,
      safety: quote?.safety,
      market: quote?.market,
      walletConfirmations: 0,
      exitRouteVerified: input.side === "buy" && isYoungMarket ? await verifySolanaExitRoute(plan) : true,
    });
    if (Number(plan.quote.priceImpactPct) * 100 > settings.maxPriceImpactPercent) throw new Error("Jupiter rota fiyat etkisi risk sınırını aşıyor.");
    if (plan.quote.slippageBps / 100 > networkLimit.maxSlippagePercent) throw new Error("Jupiter slippage ayarı risk sınırını aşıyor.");
    const nativeMarket = await getMarketDataProvider().getTokenMarket("solana", SOLANA_NATIVE_MINT);
    const marketPriceUsd = quote?.market.priceUsd ?? position?.currentPriceUsd ?? 0;
    const tradeUsd = input.side === "buy"
      ? Number(plan.quote.inAmount) / SOLANA_LAMPORTS_PER_SOL * nativeMarket.priceUsd
      : Number(plan.quote.outAmount) / SOLANA_LAMPORTS_PER_SOL * nativeMarket.priceUsd;
    assertNetworkExecutionLimit({ chainId: "solana", tradeUsd, slippagePercent: plan.quote.slippageBps / 100, side: input.side, settings });
    const estimatedNetworkFeeUsd = estimateSolanaNetworkFeeLamports(plan.estimatedPriorityFeeLamports) / SOLANA_LAMPORTS_PER_SOL * nativeMarket.priceUsd;
    const dexFeeUsd = estimateSolanaRouteFeeUsd(plan.quote, nativeMarket.priceUsd, marketPriceUsd, quote?.decimals ?? 0);
    const quotedTokenQuantity = Number(formatUnits(BigInt(input.side === "buy" ? plan.quote.outAmount : plan.quote.inAmount), quote?.decimals ?? 0));
    const quoteGuard = assertPriceDeviation({ chainId: "solana", side: input.side, referencePriceUsd: marketPriceUsd, quotedPriceUsd: quotedTokenQuantity > 0 ? tradeUsd / quotedTokenQuantity : 0, quotedAt: plan.quotedAt, quoteRefreshed: prepared.quoteRefreshed, emergencyExit: input.side === "sell" && (input.sellPercent ?? 100) === 100, settings });
    assertNetworkFeeLimit({
      chainId: "solana",
      tradeUsd,
      networkFeeUsd: estimatedNetworkFeeUsd,
      venueFeeUsd: dexFeeUsd,
      emergencyExit: input.side === "sell" && (input.sellPercent ?? 100) === 100,
      settings,
    });
    if (mode === "shadow") await assertShadowPortfolioRisk({ chainId: "solana", assetKey: input.tokenAddress, walletId: null, side: input.side, estimatedTradeUsd: tradeUsd });
    if (mode === "live") await assertLiveDailyLossLimit("solana", { assetKey: input.tokenAddress, walletId: null, side: input.side, estimatedTradeUsd: tradeUsd });
    const simulationStartedAt = performance.now();
    const execution = mode === "shadow" ? await solanaExecutionAdapter.simulate(plan) : await runLiveSubmission(requestId, (hooks) => solanaExecutionAdapter.execute(plan, hooks));
    const simulationLatencyMs = Math.round(performance.now() - simulationStartedAt);
    const actualNetworkFeeLamports = execution.networkFeeNativeAmount ? Number(execution.networkFeeNativeAmount) : null;
    const refundableRentLamports = execution.refundableRentNativeAmount ? Number(execution.refundableRentNativeAmount) : 0;
    const networkFeeUsd = actualNetworkFeeLamports === null
      ? estimatedNetworkFeeUsd
      : actualNetworkFeeLamports / SOLANA_LAMPORTS_PER_SOL * nativeMarket.priceUsd;
    const amountIn = BigInt(execution.executedAmount);
    const amountOut = BigInt(execution.receivedAmount);
    const tokenDecimals = quote?.decimals ?? 0;
    const tokenQuantity = input.side === "buy" ? Number(formatUnits(amountOut, tokenDecimals)) : Number(formatUnits(amountIn, tokenDecimals));
    const quotedPriceUsd = tokenQuantity > 0 ? tradeUsd / tokenQuantity : marketPriceUsd;
    store.updateExecutionAttempt(requestId, {
      status: mode === "shadow" ? "simulated" : "confirmed", amountIn, amountOut,
      expectedAmountOut: plan.quote.outAmount, minimumAmountOut: plan.quote.otherAmountThreshold,
      quotedPriceUsd, slippagePercent: plan.quote.slippageBps / 100, priceImpactPercent: Number(plan.quote.priceImpactPct) * 100,
      networkFeeUsd, dexFeeUsd, availableBalanceUsd: mode === "shadow" ? store.getShadowAccount("solana")?.cashBalanceUsd ?? 0 : 0,
      simulationLatencyMs, metadata: { ...quoteGuard, assetPolicy, tradeValueUsd: tradeUsd, estimatedNetworkFeeUsd, actualNetworkFeeLamports, refundableRentLamports, refundableRentDepositUsd: refundableRentLamports / SOLANA_LAMPORTS_PER_SOL * nativeMarket.priceUsd, contextSlot: plan.quote.contextSlot, computeUnitLimit: plan.transaction.computeUnitLimit, shadowSimulation: plan.shadowSimulation },
      txHash: execution.txHash,
      externalOrderId: execution.externalOrderId,
    });
    if (input.side === "buy") {
      const now = new Date().toISOString();
      const entryCostUsd = tradeUsd + networkFeeUsd;
      store.insertExecutionLot({
        id: crypto.randomUUID(), integrationId: "solana", mode, assetKey: input.tokenAddress,
        walletId: null, source: "manual", marketType: "solana", positionSide: null,
        amount: amountOut.toString(), amountFormat: "base_units", entryReference: execution.txHash,
        assetSymbol: quote?.symbol ?? position?.tokenSymbol ?? "TOKEN", assetDecimals: tokenDecimals,
        entryPriceUsd: tokenQuantity > 0 ? entryCostUsd / tokenQuantity : quotedPriceUsd,
        currentPriceUsd: marketPriceUsd, entryCostUsd, feesUsd: networkFeeUsd + dexFeeUsd,
        status: "open", openedAt: now, updatedAt: now,
      });
      if (mode === "shadow") applyShadowBuy("solana", entryCostUsd, networkFeeUsd + dexFeeUsd);
    } else {
      const netProceedsUsd = Math.max(0, Number(amountOut) / SOLANA_LAMPORTS_PER_SOL * nativeMarket.priceUsd - networkFeeUsd);
      const costBasisUsd = consumedCost(openLots, amountIn.toString());
      store.reduceExecutionLots(openLots, amountIn.toString(), { netProceedsUsd, feesUsd: networkFeeUsd + dexFeeUsd });
      if (mode === "shadow") applyShadowSell("solana", netProceedsUsd, netProceedsUsd - costBasisUsd, networkFeeUsd + dexFeeUsd);
    }
    store.markExecutionAccounted(requestId);
    if (mode === "live") await reconcileAfterLiveExecution("solana", requestId);
    await publishEmergencyExitDeviation({ chainId: "solana", asset: quote?.symbol ?? position?.tokenSymbol ?? input.tokenAddress, assessment: quoteGuard, settings, txHash: execution.txHash });
    await publishEvent({ chainId: "solana", level: "info", type: "swap", title: mode === "live" ? "Canlı Solana swap tamamlandı" : "Solana shadow simülasyonu tamamlandı", message: `${quote?.symbol ?? position?.tokenSymbol ?? "Token"} ${input.side === "buy" ? "alım" : "satım"} emri Jupiter rotasıyla ${mode === "live" ? "zincirde onaylandı" : "imzalanmadan simüle edildi"}.`, txHash: execution.txHash });
    return NextResponse.json({ execution: { requestId, mode, status: execution.status, txHash: execution.txHash, amountIn: amountIn.toString(), amountOut: amountOut.toString() } });
  } catch (error) {
    recordExecutionFailure(requestId, error);
    throw error;
  }
}

function serializeAttempt(attempt: ExecutionAttempt) {
  return {
    requestId: attempt.requestId,
    mode: attempt.mode,
    status: attempt.status,
    txHash: attempt.txHash,
    amountIn: attempt.amountIn,
    amountOut: attempt.amountOut,
    error: attempt.errorMessage,
  };
}
