import type { HypercoreFillObservation, HypercorePaperPosition, HypercorePaperTrade, HypercorePositionSide, TrackedWallet } from "@/lib/domain/types";
import { store } from "@/lib/repositories/store";
import { publishEvent } from "@/lib/services/audit-service";
import { findHypercoreMarket, getHypercoreMarkets, getHypercoreUserLeverage } from "@/lib/services/hypercore-api";
import { calculateHypercorePnl } from "@/lib/engine/hypercore-position";
import { executeHypercoreCopyExecution } from "@/lib/services/hypercore-copy-execution";
import { isWalletEligibleForCopy } from "@/lib/engine/wallet-copy-eligibility";

const MIN_TRADE_USD = 1;

export async function executeHypercoreCopyFill(wallet: TrackedWallet, fill: HypercoreFillObservation): Promise<HypercorePaperTrade | null> {
  if (!isWalletEligibleForCopy(wallet.state)) return null;
  if (store.hasHypercoreFill(fill.id)) {
    throw new Error("Bu HyperCore fill daha önce işlendi.");
  }
  const intent = resolveIntent(fill);
  if (!intent) return recordSkipped(wallet, fill, "Pozisyon yönü güvenle çözümlenemedi; flip işlemi kopyalanmadı.");
  if (store.getMode() !== "paper") {
    await executeHypercoreCopyExecution(wallet, fill);
    return null;
  }
  const tokenKey = `${fill.marketType}:${fill.coin}`.toLowerCase();

  if (intent.action === "open") {
    const consensus = store.registerCopyBuySignal("hyperliquid", tokenKey, wallet.id, fill.id);
    if (!consensus.shouldCopy) {
      return recordSkipped(
        wallet,
        fill,
        `${fill.coin} için ${consensus.distinctWalletCount} farklı cüzdan sinyali görüldü. Sonraki paper giriş için ${consensus.requiredWalletCount} cüzdan gerekiyor.`,
        intent.side,
      );
    }
    const trade = await openPosition(wallet, fill, intent.side);
    store.finishCopyBuyStage("hyperliquid", tokenKey, consensus.stage, trade.status === "confirmed");
    return trade;
  }

  return closePosition(wallet, fill, intent.side);
}

async function openPosition(wallet: TrackedWallet, fill: HypercoreFillObservation, side: HypercorePositionSide) {
  const cashBalanceUsd = store.getCashBalance();
  const startingBalanceUsd = store.getStartingBalance();
  const settings = store.getRiskSettings();
  const scoreRatio = Math.min(1, Math.max(0, (wallet.score - 45) / 40));
  const allocationPercent = settings.minPositionPercent + (settings.maxPositionPercent - settings.minPositionPercent) * scoreRatio;
  const reserveUsd = startingBalanceUsd * settings.cashReservePercent / 100;
  const marginUsd = Math.min(startingBalanceUsd * allocationPercent / 100, Math.max(0, cashBalanceUsd - reserveUsd));
  if (marginUsd < MIN_TRADE_USD) return recordSkipped(wallet, fill, "Nakit rezervi sonrasında HyperCore paper işlemi için yeterli bakiye yok.", side);

  const sourceLeverage = fill.marketType === "spot" ? 1 : await getHypercoreUserLeverage(fill.walletAddress, fill.coin).catch(() => 1);
  const leverage = fill.marketType === "spot" ? 1 : Math.max(1, Math.min(settings.maxHypercoreLeverage ?? 3, sourceLeverage));
  const notionalUsd = marginUsd * leverage;
  const feeRate = fill.notionalUsd > 0 ? fill.feeUsd / fill.notionalUsd : 0.00045;
  const slippageRate = fill.crossed ? 0.0005 : 0.00015;
  const executionPrice = fill.priceUsd * (fill.side === "buy" ? 1 + slippageRate : 1 - slippageRate);
  const quantity = notionalUsd / executionPrice;
  const feeUsd = notionalUsd * Math.max(0.0001, feeRate);
  if (marginUsd + feeUsd > cashBalanceUsd) return recordSkipped(wallet, fill, "Margin ve işlem ücreti kullanılabilir bakiyeyi aşıyor.", side);

  const existing = store.getHypercorePosition(wallet.id, fill.coin, fill.marketType, side);
  const now = new Date().toISOString();
  const totalQuantity = (existing?.quantity ?? 0) + quantity;
  const totalMargin = (existing?.marginUsd ?? 0) + marginUsd;
  const entryPriceUsd = existing
    ? (existing.entryPriceUsd * existing.quantity + executionPrice * quantity) / totalQuantity
    : executionPrice;
  const position: HypercorePaperPosition = {
    id: existing?.id ?? crypto.randomUUID(),
    walletId: wallet.id,
    walletLabel: wallet.label,
    coin: fill.coin,
    marketType: fill.marketType,
    side,
    quantity: totalQuantity,
    entryPriceUsd,
    currentPriceUsd: executionPrice,
    marginUsd: totalMargin,
    leverage,
    liquidationPriceUsd: fill.marketType === "perp" ? liquidationPrice(entryPriceUsd, leverage, side) : null,
    unrealizedPnlUsd: 0,
    fundingUsd: existing?.fundingUsd ?? 0,
    openedAt: existing?.openedAt ?? now,
    updatedAt: now,
  };
  store.setCashBalance(cashBalanceUsd - marginUsd - feeUsd);
  store.upsertHypercorePosition(position);
  const trade = createTrade(wallet, fill, side, existing ? "increase" : fill.marketType === "spot" ? "spot_buy" : "open", quantity, executionPrice, notionalUsd, marginUsd, leverage, feeUsd, 0, "confirmed", `${wallet.label} kaynaklı ${fill.marketType} ${side} sinyali risk limitleriyle paper olarak uygulandı.`);
  store.insertHypercoreTrade(trade);
  store.recordWalletObservation(wallet.id, "swap", true);
  await publishEvent({
    chainId: "hyperliquid",
    level: "info",
    type: "swap",
    title: `${fill.coin} ${fill.marketType === "spot" ? "spot" : side} paper girişi`,
    message: `${wallet.label} kaynaklı ${notionalUsd.toFixed(2)} USD notional işlem ${leverage}x kaldıraçla simüle edildi.`,
    txHash: fill.id,
  });
  return trade;
}

async function closePosition(wallet: TrackedWallet, fill: HypercoreFillObservation, side: HypercorePositionSide) {
  const position = store.getHypercorePosition(wallet.id, fill.coin, fill.marketType, side);
  if (!position) return recordSkipped(wallet, fill, `${wallet.label} cüzdanına bağlı açık ${fill.coin} ${side} pozisyonu bulunmadı.`, side);
  const sourceSize = Math.abs(fill.sourcePositionBefore);
  const closeRatio = sourceSize > 0 ? Math.min(1, fill.quantity / sourceSize) : 1;
  const quantity = Math.min(position.quantity, position.quantity * closeRatio);
  const notionalUsd = quantity * fill.priceUsd;
  const marginReleased = position.marginUsd * (quantity / position.quantity);
  const grossPnl = side === "long"
    ? (fill.priceUsd - position.entryPriceUsd) * quantity
    : (position.entryPriceUsd - fill.priceUsd) * quantity;
  const feeRate = fill.notionalUsd > 0 ? fill.feeUsd / fill.notionalUsd : 0.00045;
  const feeUsd = notionalUsd * Math.max(0.0001, feeRate);
  const realizedPnlUsd = grossPnl - feeUsd;
  const remainingQuantity = Math.max(0, position.quantity - quantity);
  if (remainingQuantity <= 0.000000001) store.deleteHypercorePosition(position.id);
  else store.upsertHypercorePosition({
    ...position,
    quantity: remainingQuantity,
    marginUsd: Math.max(0, position.marginUsd - marginReleased),
    currentPriceUsd: fill.priceUsd,
    unrealizedPnlUsd: calculateHypercorePnl(position.side, position.entryPriceUsd, fill.priceUsd, remainingQuantity),
    updatedAt: new Date().toISOString(),
  });
  store.setCashBalance(store.getCashBalance() + marginReleased + grossPnl - feeUsd);
  const action = remainingQuantity <= 0.000000001 ? (fill.marketType === "spot" ? "spot_sell" : "close") : "reduce";
  const trade = createTrade(wallet, fill, side, action, quantity, fill.priceUsd, notionalUsd, marginReleased, position.leverage, feeUsd, realizedPnlUsd, "confirmed", `${wallet.label} kaynak cüzdanının kapatma oranı paper pozisyona uygulandı.`);
  store.insertHypercoreTrade(trade);
  store.recordWalletObservation(wallet.id, "swap", true);
  await publishEvent({
    chainId: "hyperliquid",
    level: "info",
    type: "swap",
    title: `${fill.coin} paper pozisyonu ${action === "close" || action === "spot_sell" ? "kapatıldı" : "azaltıldı"}`,
    message: `${(closeRatio * 100).toFixed(1)}% çıkış uygulandı. Net gerçekleşen PnL ${realizedPnlUsd.toFixed(2)} USD.`,
    txHash: fill.id,
  });
  return trade;
}

function resolveIntent(fill: HypercoreFillObservation): { action: "open" | "close"; side: HypercorePositionSide } | null {
  if (fill.marketType === "spot") return { action: fill.side === "buy" ? "open" : "close", side: "long" };
  const direction = fill.direction.toLowerCase();
  if (direction.includes(">")) return null;
  const side = direction.includes("short") ? "short" : "long";
  return { action: direction.includes("close") ? "close" : "open", side };
}

async function recordSkipped(wallet: TrackedWallet, fill: HypercoreFillObservation, reason: string, side: HypercorePositionSide = "long") {
  const trade = createTrade(wallet, fill, side, "skipped", 0, fill.priceUsd, 0, 0, 1, 0, 0, "skipped", reason);
  store.insertHypercoreTrade(trade);
  store.recordWalletObservation(wallet.id, "swap", false);
  await publishEvent({ chainId: "hyperliquid", level: "warning", type: "swap", title: `${fill.coin} HyperCore işlemi atlandı`, message: reason, txHash: fill.id });
  return trade;
}

function createTrade(
  wallet: TrackedWallet,
  fill: HypercoreFillObservation,
  positionSide: HypercorePositionSide,
  action: HypercorePaperTrade["action"],
  quantity: number,
  priceUsd: number,
  notionalUsd: number,
  marginUsd: number,
  leverage: number,
  feeUsd: number,
  realizedPnlUsd: number,
  status: HypercorePaperTrade["status"],
  reason: string,
): HypercorePaperTrade {
  return {
    id: crypto.randomUUID(), walletId: wallet.id, source: "copy", coin: fill.coin, marketType: fill.marketType,
    side: fill.side, positionSide, action, quantity, priceUsd, notionalUsd, marginUsd, leverage, feeUsd,
    fundingUsd: 0, realizedPnlUsd, status, reason, sourceFillId: fill.id, createdAt: new Date(fill.timestamp).toISOString(),
  };
}

export interface HypercoreManualTradeInput {
  coin: string;
  positionId?: string;
  marketType: "spot" | "perp";
  positionSide: HypercorePositionSide;
  action: "open" | "close";
  allocationPercent?: number;
  closePercent?: number;
  leverage?: number;
}

export async function executeHypercoreManualTrade(input: HypercoreManualTradeInput): Promise<HypercorePaperTrade> {
  if (store.getMode() !== "paper") throw new Error("HyperCore manuel motoru yalnızca paper modda kullanılabilir.");
  if (input.marketType === "spot" && input.positionSide === "short") throw new Error("Spot piyasada short pozisyon açılamaz.");
  const markets = await getHypercoreMarkets();
  const market = findHypercoreMarket(markets, input.marketType, input.coin);
  if (!market) throw new Error("HyperCore piyasası bulunamadı.");
  const position = input.action === "close" && input.positionId
    ? store.getHypercorePositionById(input.positionId)
    : store.getHypercorePosition(null, input.coin, input.marketType, input.positionSide);
  const now = new Date().toISOString();
  const side = input.action === "open"
    ? input.positionSide === "long" ? "buy" : "sell"
    : input.positionSide === "long" ? "sell" : "buy";
  const feeRate = 0.00045;
  const price = market.priceUsd * (side === "buy" ? 1.0005 : 0.9995);

  if (input.action === "open") {
    const settings = store.getRiskSettings();
    const allocationPercent = Math.min(settings.maxPositionPercent, Math.max(settings.minPositionPercent, input.allocationPercent ?? 7.5));
    const leverage = input.marketType === "spot" ? 1 : Math.min(settings.maxHypercoreLeverage ?? 3, Math.max(1, input.leverage ?? 2));
    const cash = store.getCashBalance();
    const reserve = store.getStartingBalance() * settings.cashReservePercent / 100;
    const marginUsd = Math.min(store.getStartingBalance() * allocationPercent / 100, Math.max(0, cash - reserve));
    if (marginUsd < MIN_TRADE_USD) throw new Error("HyperCore paper işlemi için yeterli kullanılabilir bakiye yok.");
    const notionalUsd = marginUsd * leverage;
    const feeUsd = notionalUsd * feeRate;
    if (marginUsd + feeUsd > cash) throw new Error("Margin ve ücret kullanılabilir bakiyeyi aşıyor.");
    const quantity = notionalUsd / price;
    const totalQuantity = (position?.quantity ?? 0) + quantity;
    const entryPriceUsd = position ? (position.entryPriceUsd * position.quantity + price * quantity) / totalQuantity : price;
    store.setCashBalance(cash - marginUsd - feeUsd);
    store.upsertHypercorePosition({
      id: position?.id ?? crypto.randomUUID(), walletId: null, walletLabel: null, coin: input.coin,
      marketType: input.marketType, side: input.positionSide, quantity: totalQuantity, entryPriceUsd,
      currentPriceUsd: price, marginUsd: (position?.marginUsd ?? 0) + marginUsd, leverage,
      liquidationPriceUsd: input.marketType === "perp" ? liquidationPrice(entryPriceUsd, leverage, input.positionSide) : null,
      unrealizedPnlUsd: 0, fundingUsd: position?.fundingUsd ?? 0, openedAt: position?.openedAt ?? now, updatedAt: now,
    });
    const trade: HypercorePaperTrade = {
      id: crypto.randomUUID(), walletId: null, source: "manual", coin: input.coin, marketType: input.marketType,
      side, positionSide: input.positionSide, action: position ? "increase" : input.marketType === "spot" ? "spot_buy" : "open",
      quantity, priceUsd: price, notionalUsd, marginUsd, leverage, feeUsd, fundingUsd: 0, realizedPnlUsd: 0,
      status: "confirmed", reason: `Manuel HyperCore paper emri portföyün %${allocationPercent} oranıyla uygulandı.`, sourceFillId: null, createdAt: now,
    };
    store.insertHypercoreTrade(trade);
    await publishEvent({ chainId: "hyperliquid", level: "info", type: "swap", title: `${input.coin} manuel paper girişi`, message: `${notionalUsd.toFixed(2)} USD notional, ${leverage}x ${input.positionSide} pozisyon açıldı.`, txHash: null });
    return trade;
  }

  if (!position) throw new Error("Kapatılabilecek HyperCore pozisyonu bulunamadı.");
  if (position.coin !== input.coin || position.marketType !== input.marketType || position.side !== input.positionSide) {
    throw new Error("Seçilen HyperCore pozisyon bilgileri güncel değil. Sayfayı yenileyip tekrar dene.");
  }
  const closeRatio = Math.min(1, Math.max(0.01, (input.closePercent ?? 100) / 100));
  const quantity = position.quantity * closeRatio;
  const notionalUsd = quantity * price;
  const marginUsd = position.marginUsd * closeRatio;
  const feeUsd = notionalUsd * feeRate;
  const realizedPnlUsd = calculateHypercorePnl(position.side, position.entryPriceUsd, price, quantity) - feeUsd;
  const remaining = position.quantity - quantity;
  if (remaining <= 0.000000001) store.deleteHypercorePosition(position.id);
  else store.upsertHypercorePosition({ ...position, quantity: remaining, marginUsd: position.marginUsd - marginUsd, currentPriceUsd: price, unrealizedPnlUsd: calculateHypercorePnl(position.side, position.entryPriceUsd, price, remaining), updatedAt: now });
  store.setCashBalance(store.getCashBalance() + marginUsd + realizedPnlUsd);
  const trade: HypercorePaperTrade = {
    id: crypto.randomUUID(), walletId: position.walletId, source: "manual", coin: input.coin, marketType: input.marketType,
    side, positionSide: input.positionSide, action: remaining <= 0.000000001 ? input.marketType === "spot" ? "spot_sell" : "close" : "reduce",
    quantity, priceUsd: price, notionalUsd, marginUsd, leverage: position.leverage, feeUsd, fundingUsd: 0,
    realizedPnlUsd, status: "confirmed", reason: `Manuel pozisyonun %${(closeRatio * 100).toFixed(0)} kısmı kapatıldı.`, sourceFillId: null, createdAt: now,
  };
  store.insertHypercoreTrade(trade);
  await publishEvent({ chainId: "hyperliquid", level: "info", type: "swap", title: `${input.coin} manuel paper çıkışı`, message: `Net gerçekleşen PnL ${realizedPnlUsd.toFixed(2)} USD.`, txHash: null });
  return trade;
}

function liquidationPrice(entryPrice: number, leverage: number, side: HypercorePositionSide) {
  const maintenanceBuffer = 0.9 / leverage;
  return side === "long" ? entryPrice * (1 - maintenanceBuffer) : entryPrice * (1 + maintenanceBuffer);
}
