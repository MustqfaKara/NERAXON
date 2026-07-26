import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import type { HypercoreMarketType, HypercorePositionSide, TradingMode } from "@/lib/domain/types";
import { readPrivateKey } from "@/lib/security/keychain";
import { readCredentialSync } from "@/lib/security/credential-vault";
import { findHypercoreMarket, getHypercoreClearinghouseState, getHypercoreMarkets, hypercoreInfo } from "@/lib/services/hypercore-api";
import { formatHypercoreNumber, minimumHypercoreTickNotionalUsd, roundHypercoreOpenSize, roundHypercorePrice, roundHypercoreSize } from "@/lib/execution/hypercore-execution-math";
import { assertLiveExecutionEnabled } from "@/lib/execution/live-execution-switch";
import { getExecutionAccount } from "@/lib/services/execution-account-service";
import { store } from "@/lib/repositories/store";
import { clampHypercoreNotional, getNetworkExecutionLimit, hypercoreTickAdjustedMaximumUsd } from "@/lib/execution/network-execution-risk";
import { assertAssetExecutionPolicy } from "@/lib/engine/asset-execution-policy";
import type { ExecutionSubmissionHooks } from "@/lib/execution/execution-adapter";
import { hypercoreClientOrderId } from "@/lib/services/execution-lifecycle";
import { availableHypercoreSpotUsdc, effectiveHypercoreCollateralUsd, requiredPerpTransferAmount } from "@/lib/execution/hypercore-collateral";

interface ClearinghouseState {
  withdrawable?: string;
  marginSummary?: { accountValue?: string };
  assetPositions?: Array<{ position?: { coin?: string; szi?: string } }>;
}

interface SpotState {
  balances?: Array<{ coin?: string; token?: number; total?: string; hold?: string }>;
  tokenToAvailableAfterMaintenance?: Array<[number, string]>;
}

export interface HypercoreExecutionIntent {
  coin: string;
  marketType: HypercoreMarketType;
  positionSide: HypercorePositionSide;
  action: "open" | "close";
  allocationPercent?: number;
  closePercent?: number;
  exactCloseQuantity?: number;
  leverage?: number;
  slippagePercent: number;
  mode: Exclude<TradingMode, "paper">;
  certificationNotionalUsd?: { target: number; min: number; max: number };
}

export interface HypercoreExecutionPlan {
  assetId: number;
  coin: string;
  marketType: HypercoreMarketType;
  side: "buy" | "sell";
  positionSide: HypercorePositionSide;
  action: "open" | "close";
  reduceOnly: boolean;
  size: string;
  sizeDecimals: number;
  limitPrice: string;
  leverage: number;
  availableCollateralUsd: number;
  notionalUsd: number;
  minimumTradableNotionalUsd: number;
  referencePriceUsd: number;
  volume24hUsd: number;
  openInterestUsd: number;
  quotedAt: string;
}

export interface HypercoreExecutionResult {
  mode: "shadow" | "live";
  plan: HypercoreExecutionPlan;
  status: "simulated" | "filled" | "resting";
  orderId: number | null;
  filledSize: number;
  receivedSize: number;
  averagePriceUsd: number | null;
  executionFeeUsd: number | null;
}

export async function ensureHypercorePerpCollateral(requiredUsd: number) {
  assertLiveExecutionEnabled();
  const accountAddress = getExecutionAccount("hyperliquid");
  if (!accountAddress) throw new Error("Hyperliquid ana hesap adresi yapılandırılmadı.");
  const [perpState, spotState] = await Promise.all([
    hypercoreInfo<ClearinghouseState>({ type: "clearinghouseState", user: accountAddress }),
    hypercoreInfo<SpotState>({ type: "spotClearinghouseState", user: accountAddress }),
  ]);
  const perpAvailableUsd = Number(perpState.withdrawable ?? perpState.marginSummary?.accountValue ?? 0);
  const usdc = spotState.balances?.find((balance) => balance.coin === "USDC");
  const abstraction = await hypercoreInfo<string>({ type: "userAbstraction", user: accountAddress });
  const spotAvailableUsd = availableHypercoreSpotUsdc({
    abstraction,
    totalUsd: Number(usdc?.total ?? 0),
    holdUsd: Number(usdc?.hold ?? 0),
    availableAfterMaintenanceUsd: Number(
      spotState.tokenToAvailableAfterMaintenance?.find(([token]) => token === 0)?.[1] ?? Number.NaN,
    ),
  });
  const effectiveAvailableUsd = effectiveHypercoreCollateralUsd(abstraction, perpAvailableUsd, spotAvailableUsd);
  if (effectiveAvailableUsd >= requiredUsd) return { transferredUsd: 0, perpAvailableUsd: effectiveAvailableUsd };
  const transferAmount = requiredPerpTransferAmount(perpAvailableUsd, spotAvailableUsd, requiredUsd);
  if (transferAmount === 0) return { transferredUsd: 0, perpAvailableUsd };

  const privateKey = await readPrivateKey("hyperliquid-agent");
  const wallet = privateKeyToAccount(privateKey);
  if (wallet.address.toLowerCase() !== accountAddress.toLowerCase()) {
    throw new Error("Spot-perp aktarımı için Keychain anahtarı Hyperliquid ana hesabına ait olmalı.");
  }
  const exchangeUrl = readCredentialSync("hyperliquid-exchange-url") || "https://api.hyperliquid.xyz/exchange";
  const transport = new HttpTransport({ apiUrl: new URL(exchangeUrl).origin, timeout: 15_000 });
  const exchange = new ExchangeClient({ transport, wallet, defaultExpiresAfter: () => Date.now() + 10_000 });
  await exchange.usdClassTransfer({ amount: transferAmount.toFixed(2), toPerp: true });

  for (let attempt = 0; attempt < 8; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 750));
    const refreshed = await hypercoreInfo<ClearinghouseState>({ type: "clearinghouseState", user: accountAddress });
    const available = Number(refreshed.withdrawable ?? refreshed.marginSummary?.accountValue ?? 0);
    if (available >= requiredUsd) return { transferredUsd: transferAmount, perpAvailableUsd: available };
  }
  throw new Error("Hyperliquid spot-perp aktarımı gönderildi ancak perp teminatı zamanında doğrulanamadı.");
}

export async function prepareHypercoreExecution(intent: HypercoreExecutionIntent): Promise<HypercoreExecutionPlan> {
  if (intent.marketType === "spot" && intent.positionSide === "short") throw new Error("HyperCore spot piyasasında short pozisyon açılamaz.");
  const accountAddress = getExecutionAccount("hyperliquid");
  if (!accountAddress) throw new Error("Hyperliquid ana hesap adresi yapılandırılmadı.");
  const market = findHypercoreMarket(await getHypercoreMarkets(true), intent.marketType, intent.coin);
  if (!market) throw new Error("HyperCore piyasası bulunamadı.");
  const side = intent.action === "open"
    ? intent.positionSide === "long" ? "buy" : "sell"
    : intent.positionSide === "long" ? "sell" : "buy";
  const leverage = intent.marketType === "spot" ? 1 : Math.max(1, Math.min(market.maxLeverage, intent.leverage ?? 2));
  const { availableCollateralUsd, quantity } = intent.action === "open"
    ? intent.mode === "shadow"
      ? resolveShadowOpenSize(market.priceUsd, leverage, intent.allocationPercent ?? 7.5)
      : await resolveOpenSize(accountAddress, market.symbol, intent.marketType, market.priceUsd, leverage, intent.allocationPercent ?? 7.5, intent.certificationNotionalUsd)
    : intent.mode === "shadow" && intent.exactCloseQuantity !== undefined
      ? { availableCollateralUsd: store.getShadowAccount("hyperliquid")?.cashBalanceUsd ?? 0, quantity: intent.exactCloseQuantity }
      : await resolveCloseSize(accountAddress, market.symbol, intent.marketType, intent.closePercent ?? 100, intent.exactCloseQuantity);
  const limitPrice = market.priceUsd * (side === "buy" ? 1 + intent.slippagePercent / 100 : 1 - intent.slippagePercent / 100);
  const roundedPrice = roundHypercorePrice(limitPrice, market.sizeDecimals, market.marketType, side);
  const executionLimit = getNetworkExecutionLimit("hyperliquid", store.getRiskSettings());
  const minimumNotionalUsd = intent.certificationNotionalUsd?.min ?? executionLimit.minTradeUsd;
  const minimumTradableNotionalUsd = minimumHypercoreTickNotionalUsd(roundedPrice, market.sizeDecimals, minimumNotionalUsd);
  const maximumNotionalUsd = intent.certificationNotionalUsd?.max
    ?? hypercoreTickAdjustedMaximumUsd(executionLimit.maxTradeUsd, minimumTradableNotionalUsd);
  const roundedSize = intent.action === "open"
    ? roundHypercoreOpenSize({
        quantity,
        sizeDecimals: market.sizeDecimals,
        priceUsd: roundedPrice,
        minimumNotionalUsd,
        maximumNotionalUsd,
        availableNotionalUsd: availableCollateralUsd * leverage,
      })
    : roundHypercoreSize(quantity, market.sizeDecimals);
  if (roundedSize <= 0) throw new Error("HyperCore tick kuralları sonrasında emir miktarı sıfır kaldı.");
  return {
    assetId: market.assetId,
    coin: market.symbol,
    marketType: market.marketType,
    side,
    positionSide: intent.positionSide,
    action: intent.action,
    reduceOnly: intent.action === "close" && intent.marketType === "perp",
    size: formatHypercoreNumber(roundedSize, market.sizeDecimals),
    sizeDecimals: market.sizeDecimals,
    limitPrice: formatHypercoreNumber(roundedPrice, Math.max(0, (market.marketType === "spot" ? 8 : 6) - market.sizeDecimals)),
    leverage,
    availableCollateralUsd,
    notionalUsd: roundedSize * roundedPrice,
    minimumTradableNotionalUsd,
    referencePriceUsd: market.priceUsd,
    volume24hUsd: market.volume24hUsd,
    openInterestUsd: market.openInterestUsd,
    quotedAt: new Date().toISOString(),
  };
}

export async function executeHypercorePlan(plan: HypercoreExecutionPlan, mode: "shadow" | "live", hooks?: ExecutionSubmissionHooks): Promise<HypercoreExecutionResult> {
  assertAssetExecutionPolicy({ chainId: "hyperliquid", asset: `${plan.marketType}:${plan.coin}`, opensPosition: plan.action === "open", settings: store.getRiskSettings(), marketType: plan.marketType, volume24hUsd: plan.volume24hUsd, openInterestUsd: plan.openInterestUsd });
  if (mode === "shadow") {
    const market = findHypercoreMarket(await getHypercoreMarkets(true), plan.marketType, plan.coin);
    if (!market) throw new Error("HyperCore shadow doğrulamasında piyasa bulunamadı.");
    const size = Number(plan.size);
    const price = Number(plan.limitPrice);
    if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(price) || price <= 0) throw new Error("HyperCore shadow emir miktarı veya fiyatı geçersiz.");
    if (plan.action === "open" && plan.notionalUsd > plan.availableCollateralUsd * plan.leverage + 0.01) {
      throw new Error("HyperCore shadow emri kullanılabilir teminatı aşıyor.");
    }
    const priceDistancePercent = Math.abs(price / market.priceUsd - 1) * 100;
    if (priceDistancePercent > 2) throw new Error(`HyperCore shadow limit fiyatı piyasadan %${priceDistancePercent.toFixed(2)} uzakta.`);
    return {
      mode,
      plan,
      status: "simulated",
      orderId: null,
      filledSize: size,
      receivedSize: size,
      averagePriceUsd: price,
      executionFeeUsd: plan.notionalUsd * 0.00035,
    };
  }
  assertLiveExecutionEnabled();
  const privateKey = await readPrivateKey("hyperliquid-agent");
  const wallet = privateKeyToAccount(privateKey);
  const accountAddress = getExecutionAccount("hyperliquid");
  if (!accountAddress) throw new Error("Hyperliquid ana hesap adresi yapılandırılmadı.");
  const spotBalanceBefore = plan.marketType === "spot" ? await readSpotBalance(accountAddress, plan.coin) : null;
  const exchangeUrl = readCredentialSync("hyperliquid-exchange-url") || "https://api.hyperliquid.xyz/exchange";
  const transport = new HttpTransport({ apiUrl: new URL(exchangeUrl).origin, timeout: 15_000 });
  const exchange = new ExchangeClient({ transport, wallet, defaultExpiresAfter: () => Date.now() + 10_000 });
  if (plan.marketType === "perp" && !plan.reduceOnly) {
    await exchange.updateLeverage({ asset: plan.assetId, isCross: true, leverage: plan.leverage });
  }
  const clientOrderId = hypercoreClientOrderId(hooks?.idempotencyKey ?? `${plan.marketType}:${plan.coin}:${plan.quotedAt}`);
  await hooks?.onSubmitted({ externalOrderId: clientOrderId });
  const response = await exchange.order({
    orders: [{
      a: plan.assetId,
      b: plan.side === "buy",
      p: plan.limitPrice,
      s: plan.size,
      r: plan.reduceOnly,
      t: { limit: { tif: "Ioc" } },
      c: clientOrderId,
    }],
    grouping: "na",
  });
  const orderStatus = response.response.data.statuses[0];
  if (typeof orderStatus === "object" && "error" in orderStatus) throw new Error(`HyperCore emri reddedildi: ${orderStatus.error}`);
  if (typeof orderStatus === "object" && "filled" in orderStatus) {
    await hooks?.onSubmitted({ externalOrderId: String(orderStatus.filled.oid) });
    const filledSize = Number(orderStatus.filled.totalSz);
    const fillDetails = await waitForFillDetails(accountAddress, orderStatus.filled.oid);
    const receivedSize = plan.marketType === "spot" && plan.side === "buy" && spotBalanceBefore !== null
      ? await waitForSpotBalanceIncrease(accountAddress, plan.coin, spotBalanceBefore)
      : filledSize;
    return {
    mode,
    plan,
    status: "filled",
    orderId: orderStatus.filled.oid,
    filledSize,
    receivedSize,
    averagePriceUsd: fillDetails?.priceUsd ?? Number(orderStatus.filled.avgPx),
    executionFeeUsd: fillDetails?.feeUsd ?? null,
    };
  }
  if (typeof orderStatus === "object" && "resting" in orderStatus) {
    await hooks?.onSubmitted({ externalOrderId: String(orderStatus.resting.oid) });
    return {
      mode,
      plan,
      status: "resting",
      orderId: orderStatus.resting.oid,
      filledSize: 0,
      receivedSize: 0,
      averagePriceUsd: null,
      executionFeeUsd: null,
    };
  }
  throw new Error("HyperCore emrinin kesinleşme durumu çözümlenemedi.");
}

async function readSpotBalance(address: string, coin: string) {
  const state = await hypercoreInfo<SpotState>({ type: "spotClearinghouseState", user: address });
  const balance = state.balances?.find((item) => item.coin?.toUpperCase() === coin.toUpperCase());
  return Math.max(0, Number(balance?.total ?? 0) - Number(balance?.hold ?? 0));
}

async function waitForSpotBalanceIncrease(address: string, coin: string, previous: number) {
  let current = await readSpotBalance(address, coin);
  for (let attempt = 0; attempt < 8 && current <= previous; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    current = await readSpotBalance(address, coin);
  }
  const received = current - previous;
  if (received <= 0) throw new Error("HyperCore spot emri fill oldu ancak net token bakiyesi doğrulanamadı.");
  return received;
}

async function waitForFillDetails(address: string, orderId: number) {
  const startTime = Date.now() - 2 * 60_000;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const fills = await hypercoreInfo<Array<{
      oid?: number;
      px?: string;
      fee?: string;
      feeToken?: string;
    }>>({
      type: "userFillsByTime",
      user: address.toLowerCase(),
      startTime,
      aggregateByTime: true,
    }).catch(() => []);
    const fill = fills.find((item) => item.oid === orderId);
    if (fill) {
      const priceUsd = Number(fill.px ?? 0);
      const feeUsd = fill.feeToken === "USDC" ? Math.abs(Number(fill.fee ?? 0)) : null;
      return {
        priceUsd: Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : null,
        feeUsd: feeUsd !== null && Number.isFinite(feeUsd) ? feeUsd : null,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return null;
}

async function resolveOpenSize(
  address: string,
  coin: string,
  marketType: HypercoreMarketType,
  priceUsd: number,
  leverage: number,
  allocationPercent: number,
  certificationNotionalUsd?: { target: number; min: number; max: number },
) {
  if (allocationPercent <= 0 || allocationPercent > 100) throw new Error("HyperCore bütçe oranı 0-100 aralığında olmalı.");
  let availableCollateralUsd = 0;
  if (marketType === "perp") {
    const [state, spotState, abstraction] = await Promise.all([
      hypercoreInfo<ClearinghouseState>({ type: "clearinghouseState", user: address }),
      hypercoreInfo<SpotState>({ type: "spotClearinghouseState", user: address }),
      hypercoreInfo<string>({ type: "userAbstraction", user: address }),
    ]);
    const perpAvailableUsd = Number(state.withdrawable ?? state.marginSummary?.accountValue ?? 0);
    const usdc = spotState.balances?.find((balance) => balance.coin === "USDC");
    const spotAvailableUsd = availableHypercoreSpotUsdc({
      abstraction,
      totalUsd: Number(usdc?.total ?? 0),
      holdUsd: Number(usdc?.hold ?? 0),
      availableAfterMaintenanceUsd: Number(
        spotState.tokenToAvailableAfterMaintenance?.find(([token]) => token === 0)?.[1] ?? Number.NaN,
      ),
    });
    availableCollateralUsd = effectiveHypercoreCollateralUsd(abstraction, perpAvailableUsd, spotAvailableUsd);
  } else {
    const state = await hypercoreInfo<SpotState>({ type: "spotClearinghouseState", user: address });
    const usdc = state.balances?.find((balance) => balance.coin === "USDC");
    availableCollateralUsd = Math.max(0, Number(usdc?.total ?? 0) - Number(usdc?.hold ?? 0));
  }
  const marginUsd = availableCollateralUsd * allocationPercent / 100;
  const executionLimit = getNetworkExecutionLimit("hyperliquid", store.getRiskSettings());
  const reserveAdjustedCapacity = availableCollateralUsd * (1 - executionLimit.cashReservePercent / 100) * leverage;
  const notionalUsd = certificationNotionalUsd
    ? Math.min(certificationNotionalUsd.max, reserveAdjustedCapacity, Math.max(certificationNotionalUsd.min, certificationNotionalUsd.target))
    : clampHypercoreNotional(marginUsd * leverage, availableCollateralUsd, leverage, store.getRiskSettings());
  if (certificationNotionalUsd && notionalUsd + 0.01 < certificationNotionalUsd.min) throw new Error("HyperCore teminatı azaltma sertifikasının minimum notional değerini karşılamıyor.");
  if (notionalUsd < 1) throw new Error("HyperCore kullanılabilir teminatı minimum emir için yetersiz.");
  return { availableCollateralUsd, quantity: notionalUsd / priceUsd };
}

function resolveShadowOpenSize(priceUsd: number, leverage: number, allocationPercent: number) {
  if (allocationPercent <= 0 || allocationPercent > 100) throw new Error("HyperCore bütçe oranı 0-100 aralığında olmalı.");
  const availableCollateralUsd = store.getShadowAccount("hyperliquid")?.cashBalanceUsd ?? 0;
  const desiredNotionalUsd = availableCollateralUsd * allocationPercent / 100 * leverage;
  const notionalUsd = clampHypercoreNotional(desiredNotionalUsd, availableCollateralUsd, leverage, store.getRiskSettings());
  if (notionalUsd < 1) throw new Error("HyperCore shadow teminatı minimum emir için yetersiz.");
  return { availableCollateralUsd, quantity: notionalUsd / priceUsd };
}

async function resolveCloseSize(address: string, coin: string, marketType: HypercoreMarketType, closePercent: number, exactCloseQuantity?: number) {
  if (closePercent <= 0 || closePercent > 100) throw new Error("Kapatma oranı 0-100 aralığında olmalı.");
  if (marketType === "perp") {
    const state = await getHypercoreClearinghouseState<ClearinghouseState>(address, coin);
    const size = Math.abs(Number(state.assetPositions?.find((item) => item.position?.coin === coin)?.position?.szi ?? 0));
    if (size <= 0) throw new Error("Kapatılabilecek canlı perp pozisyonu bulunamadı.");
    return { availableCollateralUsd: Number(state.withdrawable ?? state.marginSummary?.accountValue ?? 0), quantity: exactCloseQuantity === undefined ? size * closePercent / 100 : Math.min(size, exactCloseQuantity) };
  }
  const state = await hypercoreInfo<SpotState>({ type: "spotClearinghouseState", user: address });
  const balance = state.balances?.find((item) => item.coin === coin);
  const available = Math.max(0, Number(balance?.total ?? 0) - Number(balance?.hold ?? 0));
  if (available <= 0) throw new Error("Satılabilecek canlı spot bakiyesi bulunamadı.");
  return { availableCollateralUsd: 0, quantity: exactCloseQuantity === undefined ? available * closePercent / 100 : Math.min(available, exactCloseQuantity) };
}
