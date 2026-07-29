import { erc20Abi, type Address } from "viem";
import { PublicKey } from "@solana/web3.js";
import { getPublicClient } from "@/lib/chains/public-client";
import type {
  EvmChainId,
  ExecutionLot,
  HypercorePaperPosition,
  HypercorePositionSide,
  PositionLot,
  TrackedWallet,
} from "@/lib/domain/types";
import { executeHypercoreCopyFill } from "@/lib/engine/hypercore-paper-trading";
import { dexFeePercentFor } from "@/lib/engine/paper-execution-model";
import { executePaperTrade } from "@/lib/engine/paper-trading";
import { store } from "@/lib/repositories/store";
import { publishEvent } from "@/lib/services/audit-service";
import { findHypercoreMarket, getHypercoreMarkets, hypercoreInfo } from "@/lib/services/hypercore-api";
import { resolveTokenQuote } from "@/lib/services/token-quote-service";
import { solanaRpc } from "@/lib/solana/helius-client";
import { closeShadowExecutionLots } from "@/lib/services/shadow-position-service";
import { isEvmChain } from "@/lib/domain/defaults";
import { hasMeaningfulBaseUnitBalance, hasMeaningfulDecimalBalance } from "@/lib/engine/source-balance";

interface ReconciliationResult {
  id: string;
  walletLabel: string;
  asset: string;
  network: string;
  sourceHoldsPosition: boolean | null;
  status: "kept" | "closed" | "failed" | "skipped";
  detail: string;
}

interface ClearinghouseState {
  assetPositions?: Array<{ position?: { coin?: string; szi?: string } }>;
}

interface SpotState {
  balances?: Array<{ coin?: string; total?: string; hold?: string }>;
}

interface SolanaTokenAccounts {
  value: Array<{
    account?: {
      data?: {
        parsed?: {
          info?: {
            tokenAmount?: { amount?: string; decimals?: number };
          };
        };
      };
    };
  }>;
}

interface SolanaTransaction {
  meta?: {
    preTokenBalances?: Array<{ mint?: string }>;
    postTokenBalances?: Array<{ mint?: string }>;
  };
}

export async function reconcileSourcePositions(options: { publishNoop?: boolean } = {}) {
  const mode = store.getMode();
  if (mode === "shadow") return reconcileShadowSourcePositions(options);
  if (mode === "live") throw new Error("Canlı kaynak pozisyon mutabakatı otomatik emir göndermeden önce ayrıca onaylanmalıdır.");

  const results: ReconciliationResult[] = [];
  const copyLotGroups = groupCopyLots(store.listPositionLots());
  for (const lots of copyLotGroups) {
    results.push(await reconcileSpotLots(lots));
  }

  const markets = await getHypercoreMarkets().catch(() => []);
  for (const position of store.listHypercorePositions().filter((item) => item.walletId)) {
    results.push(await reconcileHypercorePosition(position, markets));
  }

  const closedCount = results.filter((result) => result.status === "closed").length;
  const failedCount = results.filter((result) => result.status === "failed").length;
  await publishEvent({
    chainId: null,
    level: failedCount ? "warning" : "info",
    type: "system",
    title: "Kaynak cüzdan pozisyon kontrolü tamamlandı",
    message: `${results.length} kaynak pozisyon kontrol edildi; ${closedCount} paper pozisyon kapatıldı, ${failedCount} kontrol güvenle tamamlanamadı.`,
    txHash: null,
  });

  return {
    checkedCount: results.length,
    closedCount,
    keptCount: results.filter((result) => result.status === "kept").length,
    failedCount,
    results,
  };
}

async function reconcileShadowSourcePositions(options: { publishNoop?: boolean }) {
  const results: ReconciliationResult[] = [];
  for (const lots of groupShadowCopyLots(store.listExecutionLots("shadow"))) {
    results.push(await reconcileShadowLots(lots));
  }

  const closedCount = results.filter((result) => result.status === "closed").length;
  const failedCount = results.filter((result) => result.status === "failed").length;
  if (options.publishNoop !== false || closedCount > 0 || failedCount > 0) {
    await publishEvent({
      chainId: null,
      level: failedCount ? "warning" : "info",
      type: "system",
      title: "Shadow kaynak cüzdan pozisyon kontrolü tamamlandı",
      message: `${results.length} kaynak pozisyon kontrol edildi; ${closedCount} shadow pozisyon simüle edilerek kapatıldı, ${failedCount} kontrol tamamlanamadı.`,
      txHash: null,
    });
  }
  return {
    checkedCount: results.length,
    closedCount,
    keptCount: results.filter((result) => result.status === "kept").length,
    failedCount,
    results,
  };
}

async function reconcileShadowLots(lots: ExecutionLot[]): Promise<ReconciliationResult> {
  const lot = lots[0];
  const wallet = lot.walletId ? store.getWallet(lot.walletId) : null;
  const base = {
    id: `${lot.integrationId}:${lot.assetKey}:${lot.walletId}:${lot.positionSide ?? "spot"}`,
    walletLabel: wallet?.label ?? "Bilinmeyen cüzdan",
    asset: lot.assetSymbol || lot.assetKey,
    network: lot.integrationId === "hyperliquid" ? `hyperliquid:${lot.marketType}` : lot.integrationId,
  };
  if (!wallet) return { ...base, sourceHoldsPosition: null, status: "skipped", detail: "Kaynak cüzdan bulunamadı." };

  try {
    const sourceHoldsPosition = lot.integrationId === "solana"
      ? await solanaWalletHoldsToken(wallet.address, lot.assetKey)
      : lot.integrationId === "hyperliquid"
        ? await hypercoreWalletHoldsExecutionLot(wallet, lot)
        : isEvmChain(lot.integrationId)
          ? await evmWalletHoldsToken(lot.integrationId, wallet.address, lot.assetKey)
          : null;
    if (sourceHoldsPosition === null) return { ...base, sourceHoldsPosition: null, status: "skipped", detail: "Ağ için kaynak pozisyon kontrolü desteklenmiyor." };
    if (sourceHoldsPosition) return { ...base, sourceHoldsPosition: true, status: "kept", detail: "Kaynak cüzdan pozisyonu hâlâ tutuyor." };

    await closeShadowExecutionLots(lots, "source-reconciliation");
    return { ...base, sourceHoldsPosition: false, status: "closed", detail: "Kaynak cüzdanda pozisyon kalmadığı için bağlı shadow lotları simüle edilerek kapatıldı." };
  } catch (error) {
    return { ...base, sourceHoldsPosition: null, status: "failed", detail: messageOf(error) };
  }
}

async function reconcileSpotLots(lots: PositionLot[]): Promise<ReconciliationResult> {
  const lot = lots[0];
  const wallet = lot.walletId ? store.getWallet(lot.walletId) : null;
  const base = {
    id: `${lot.chainId}:${lot.tokenAddress}:${lot.walletId}`,
    walletLabel: wallet?.label ?? lot.walletLabel ?? "Bilinmeyen cüzdan",
    asset: lot.tokenSymbol,
    network: lot.chainId,
  };
  if (!wallet || lot.chainId === "hyperliquid") {
    return { ...base, sourceHoldsPosition: null, status: "skipped", detail: "Kaynak cüzdan veya ağ bilgisi çözümlenemedi." };
  }

  try {
    const tokenAddress = lot.chainId === "solana" ? await canonicalSolanaMint(lots) : lot.tokenAddress;
    const sourceHoldsPosition = lot.chainId === "solana"
      ? await solanaWalletHoldsToken(wallet.address, tokenAddress)
      : await evmWalletHoldsToken(lot.chainId, wallet.address, tokenAddress);
    if (sourceHoldsPosition) {
      return { ...base, sourceHoldsPosition: true, status: "kept", detail: "Kaynak cüzdan tokeni hâlâ tutuyor." };
    }

    const position = store.getPosition(lot.chainId, tokenAddress);
    const quote = await resolveTokenQuote(lot.chainId, tokenAddress).catch(() => null);
    const fallbackPrice = position?.currentPriceUsd ?? lot.entryPriceUsd;
    const trade = await executePaperTrade({
      chainId: lot.chainId,
      side: "sell",
      tokenAddress: quote?.address ?? tokenAddress,
      tokenSymbol: quote?.symbol ?? lot.tokenSymbol,
      tokenDecimals: quote?.decimals,
      pairAddress: quote?.market.pairAddress ?? lot.pairAddress,
      priceUsd: quote?.market.priceUsd ?? fallbackPrice,
      liquidityUsd: quote?.market.liquidityUsd,
      gasFeeUsd: quote?.gas.feeUsd,
      dexFeePercent: dexFeePercentFor(quote?.market.dexId),
      priceChange24hPercent: quote?.market.priceChange24hPercent,
      sellPercent: 100,
      slippagePercent: 0.5,
    }, {
      source: "copy",
      walletId: wallet.id,
      walletScore: wallet.score,
      sourceLabel: wallet.label,
      txHash: `source-reconcile:${crypto.randomUUID()}`,
    });
    if (trade.status !== "confirmed") throw new Error(trade.reason);
    return { ...base, sourceHoldsPosition: false, status: "closed", detail: "Kaynak cüzdan bakiyesi sıfır olduğu için cüzdana bağlı paper lotları satıldı." };
  } catch (error) {
    return { ...base, sourceHoldsPosition: null, status: "failed", detail: messageOf(error) };
  }
}

async function reconcileHypercorePosition(
  position: HypercorePaperPosition,
  markets: Awaited<ReturnType<typeof getHypercoreMarkets>>,
): Promise<ReconciliationResult> {
  const wallet = position.walletId ? store.getWallet(position.walletId) : null;
  const base = {
    id: position.id,
    walletLabel: wallet?.label ?? position.walletLabel ?? "Bilinmeyen cüzdan",
    asset: position.coin,
    network: `hyperliquid:${position.marketType}`,
  };
  if (!wallet) {
    return { ...base, sourceHoldsPosition: null, status: "skipped", detail: "Kaynak cüzdan bulunamadı." };
  }

  try {
    const sourceHoldsPosition = await hypercoreWalletHoldsPosition(wallet, position);
    if (sourceHoldsPosition) {
      return { ...base, sourceHoldsPosition: true, status: "kept", detail: "Kaynak cüzdan aynı yöndeki pozisyonu hâlâ tutuyor." };
    }

    const market = findHypercoreMarket(markets, position.marketType, position.coin);
    if (!market) throw new Error("HyperCore piyasası bulunamadı; pozisyon güvenlik gereği korunuyor.");
    const side = position.side === "long" ? "sell" : "buy";
    const fillId = `source-reconcile:${crypto.randomUUID()}`;
    const trade = await executeHypercoreCopyFill(wallet, {
      id: fillId,
      walletAddress: wallet.address,
      coin: position.coin,
      marketType: position.marketType,
      side,
      direction: position.side === "long" ? "Close Long" : "Close Short",
      priceUsd: market.priceUsd,
      quantity: position.quantity,
      notionalUsd: position.quantity * market.priceUsd,
      feeUsd: position.quantity * market.priceUsd * 0.00045,
      closedPnlUsd: 0,
      crossed: false,
      sourcePositionBefore: signedSize(position.quantity, position.side),
      timestamp: Date.now(),
    });
    if (!trade || trade.status !== "confirmed") throw new Error(trade?.reason ?? "HyperCore paper kapanışı doğrulanamadı.");
    return { ...base, sourceHoldsPosition: false, status: "closed", detail: "Kaynak cüzdanda aynı yönlü pozisyon kalmadığı için paper pozisyon kapatıldı." };
  } catch (error) {
    return { ...base, sourceHoldsPosition: null, status: "failed", detail: messageOf(error) };
  }
}

async function evmWalletHoldsToken(chainId: EvmChainId, walletAddress: string, tokenAddress: string) {
  const client = getPublicClient(chainId);
  const [balance, decimals] = await Promise.all([
    client.readContract({ address: tokenAddress as Address, abi: erc20Abi, functionName: "balanceOf", args: [walletAddress as Address] }),
    client.readContract({ address: tokenAddress as Address, abi: erc20Abi, functionName: "decimals" }),
  ]);
  return hasMeaningfulBaseUnitBalance(balance, decimals);
}

async function solanaWalletHoldsToken(walletAddress: string, mintAddress: string) {
  const response = await solanaRpc<SolanaTokenAccounts>("getTokenAccountsByOwner", [
    walletAddress,
    { mint: mintAddress },
    { encoding: "jsonParsed", commitment: "confirmed" },
  ]);
  return response.value.some((item) => {
    const tokenAmount = item.account?.data?.parsed?.info?.tokenAmount;
    return hasMeaningfulBaseUnitBalance(BigInt(tokenAmount?.amount ?? "0"), tokenAmount?.decimals ?? 0);
  });
}

async function canonicalSolanaMint(lots: PositionLot[]) {
  const storedAddress = lots[0].tokenAddress;
  const openingTradeIds = new Set(lots.map((lot) => lot.openedTradeId).filter(Boolean));
  const openingTrade = store.listAllTrades().find((trade) => openingTradeIds.has(trade.id) && trade.txHash);
  if (openingTrade?.txHash) {
    const transaction = await solanaRpc<SolanaTransaction | null>("getTransaction", [
      openingTrade.txHash,
      { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
    ]);
    const mints = [
      ...(transaction?.meta?.preTokenBalances ?? []),
      ...(transaction?.meta?.postTokenBalances ?? []),
    ].map((item) => item.mint).filter((mint): mint is string => Boolean(mint));
    const canonicalAddress = mints.find((mint) => mint.toLowerCase() === storedAddress.toLowerCase());
    if (canonicalAddress) {
      store.replacePositionAssetAddress("solana", storedAddress, canonicalAddress);
      return canonicalAddress;
    }
  }
  try {
    return new PublicKey(storedAddress).toBase58();
  } catch {
    throw new Error("Canonical Solana mint adresi doğrulanamadı; pozisyon güvenlik gereği korunuyor.");
  }
}

async function hypercoreWalletHoldsPosition(wallet: TrackedWallet, position: HypercorePaperPosition) {
  if (position.marketType === "spot") {
    const state = await hypercoreInfo<SpotState>({ type: "spotClearinghouseState", user: wallet.address });
    const balance = state.balances?.find((item) => sameCoin(item.coin, position.coin));
    return hasMeaningfulDecimalBalance(Math.max(0, Number(balance?.total ?? 0) - Number(balance?.hold ?? 0)));
  }

  const dex = position.coin.includes(":") ? position.coin.split(":", 1)[0] : null;
  const state = await hypercoreInfo<ClearinghouseState>({
    type: "clearinghouseState",
    user: wallet.address,
    ...(dex ? { dex } : {}),
  });
  const sourceSize = Number(state.assetPositions?.find((item) => sameCoin(item.position?.coin, position.coin))?.position?.szi ?? 0);
  return position.side === "long" ? sourceSize > 0 : sourceSize < 0;
}

async function hypercoreWalletHoldsExecutionLot(wallet: TrackedWallet, lot: ExecutionLot) {
  const coin = lot.assetSymbol || lot.assetKey.split(":").at(-1)!;
  if (lot.marketType === "spot") {
    const state = await hypercoreInfo<SpotState>({ type: "spotClearinghouseState", user: wallet.address });
    const balance = state.balances?.find((item) => sameCoin(item.coin, coin));
    return hasMeaningfulDecimalBalance(Math.max(0, Number(balance?.total ?? 0) - Number(balance?.hold ?? 0)));
  }
  const dex = coin.includes(":") ? coin.split(":", 1)[0] : null;
  const state = await hypercoreInfo<ClearinghouseState>({
    type: "clearinghouseState",
    user: wallet.address,
    ...(dex ? { dex } : {}),
  });
  const sourceSize = Number(state.assetPositions?.find((item) => sameCoin(item.position?.coin, coin))?.position?.szi ?? 0);
  return lot.positionSide === "short" ? sourceSize < 0 : sourceSize > 0;
}

function groupCopyLots(lots: PositionLot[]) {
  const groups = new Map<string, PositionLot[]>();
  for (const lot of lots.filter((item) => item.source === "copy" && item.walletId)) {
    const addressKey = lot.chainId === "solana" ? lot.tokenAddress : lot.tokenAddress.toLowerCase();
    const key = `${lot.chainId}:${addressKey}:${lot.walletId}`;
    groups.set(key, [...(groups.get(key) ?? []), lot]);
  }
  return [...groups.values()];
}

function groupShadowCopyLots(lots: ExecutionLot[]) {
  const groups = new Map<string, ExecutionLot[]>();
  for (const lot of lots.filter((item) => item.status === "open" && item.source === "copy" && item.walletId)) {
    const key = `${lot.integrationId}:${lot.assetKey.toLowerCase()}:${lot.walletId}:${lot.positionSide ?? "spot"}`;
    groups.set(key, [...(groups.get(key) ?? []), lot]);
  }
  return [...groups.values()];
}

function sameCoin(candidate: string | undefined, expected: string) {
  if (!candidate) return false;
  const normalizedCandidate = candidate.toLowerCase();
  const normalizedExpected = expected.toLowerCase();
  return normalizedCandidate === normalizedExpected
    || normalizedCandidate === normalizedExpected.split(":").at(-1);
}

function signedSize(quantity: number, side: HypercorePositionSide) {
  return side === "long" ? quantity : -quantity;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "Kaynak pozisyon kontrol edilemedi.";
}
