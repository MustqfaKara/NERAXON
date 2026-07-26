import { createHash } from "node:crypto";
import { TelegramClient } from "teleproto";
import { NewMessage, type NewMessageEvent } from "teleproto/events/index.js";
import { LogLevel } from "teleproto/extensions/Logger.js";
import { StringSession } from "teleproto/sessions/index.js";
import type {
  ChainId,
  SocialTokenSignal,
  TelegramSocialStatus,
  TelegramUserChat,
} from "@/lib/domain/types";
import {
  extractSocialTokenReferences,
  type SocialTokenReference,
} from "@/lib/engine/social-token-extractor";
import {
  pairToSocialMarket,
  type DexScreenerSocialPair,
  type ResolvedSocialMarket,
} from "@/lib/engine/social-market-pair";
import { shouldRequestSocialAi } from "@/lib/engine/social-ai-policy";
import { store } from "@/lib/repositories/store";
import {
  readTelegramUserCredentials,
  readTelegramUserSession,
} from "@/lib/security/telegram-user-keychain";
import { queueTradeAdvisory } from "@/lib/services/ai-trade-advisor";
import {
  getMarketDataProvider,
  type MarketSnapshot,
} from "@/lib/services/market-data-provider";
import { monitorService, recordServiceHealth } from "@/lib/services/service-health";
import { collectSocialProjectResearch } from "@/lib/services/social-project-research";

interface RuntimeState {
  client: TelegramClient<StringSession> | null;
  chats: TelegramUserChat[];
  chatTitles: Map<string, string>;
  handler: ((event: NewMessageEvent) => Promise<void>) | null;
  eventBuilder: NewMessage | null;
  selectionKey: string;
  connecting: Promise<void> | null;
  aiBatchTimer: ReturnType<typeof setTimeout> | null;
  aiBatchWindow: number | null;
  aiBatchRunning: Promise<void> | null;
  status: TelegramSocialStatus;
}

const SOCIAL_AI_BATCH_INTERVAL_MS = 15 * 60 * 1_000;
const SOCIAL_AI_BACKLOG_MS = 6 * 60 * 60 * 1_000;
const SOCIAL_MARKET_RESOLVER_VERSION = "dexscreener-universal-v1";
const DEXSCREENER_SLUG_BY_CHAIN: Partial<Record<ChainId, string>> = {
  ethereum: "ethereum",
  base: "base",
  robinhood: "robinhood",
  solana: "solana",
};

const globalState = globalThis as typeof globalThis & { neraxonTelegramUserSignals?: RuntimeState };
const state = () => (globalState.neraxonTelegramUserSignals ??= {
  client: null,
  chats: [],
  chatTitles: new Map(),
  handler: null,
  eventBuilder: null,
  selectionKey: "",
  connecting: null,
  aiBatchTimer: null,
  aiBatchWindow: null,
  aiBatchRunning: null,
  status: {
    connected: false,
    accountLabel: null,
    lastConnectedAt: null,
    lastSignalAt: null,
    lastError: null,
  },
});

export async function listTelegramUserChats(forceRefresh = false) {
  await ensureConnected();
  const current = state();
  if (!forceRefresh && current.chats.length) return withSelection(current.chats);
  const dialogs = await current.client!.getDialogs({ limit: 250 });
  current.chats = dialogs
    .filter((dialog) => dialog.isGroup || dialog.isChannel)
    .map((dialog) => ({
      id: String(dialog.id),
      title: dialog.title || dialog.name || "İsimsiz Telegram kaynağı",
      kind: dialog.isChannel && !dialog.isGroup ? "channel" as const : "group" as const,
      selected: false,
    }))
    .filter((chat, index, all) => all.findIndex((item) => item.id === chat.id) === index)
    .sort((left, right) => left.title.localeCompare(right.title, "tr"));
  current.chatTitles = new Map(current.chats.map((chat) => [chat.id, chat.title]));
  return withSelection(current.chats);
}

export function getTelegramSocialRuntimeStatus() {
  return { ...state().status };
}

export async function refreshSocialSignalMarkets() {
  const storedSignals = store.listSocialTokenSignals(500);
  const retryCandidates = storedSignals
    .filter((signal) =>
      signal.status === "market_unavailable"
      && signal.resolverVersion !== SOCIAL_MARKET_RESOLVER_VERSION
      && signal.referenceType !== "ticker"
      && Boolean(signal.tokenAddress || signal.pairAddress)
    )
    .slice(0, 25);
  await Promise.allSettled(retryCandidates.map((signal) =>
    resolveAndStoreSignal(signal, referenceFromSignal(signal)),
  ));

  const signals = store.listSocialTokenSignals(500)
    .filter((signal) => signal.status === "analyzed" && signal.chainId && signal.tokenAddress);
  const externalSignals = store.listSocialTokenSignals(500)
    .filter((signal) =>
      signal.status === "analyzed"
      && !signal.chainId
      && signal.dexScreenerChainId
      && signal.tokenAddress
      && Date.now() - Date.parse(signal.updatedAt) >= 5 * 60_000
    )
    .filter((signal, index, all) =>
      all.findIndex((candidate) =>
        candidate.dexScreenerChainId === signal.dexScreenerChainId
        && candidate.tokenAddress?.toLowerCase() === signal.tokenAddress?.toLowerCase()
      ) === index
    )
    .slice(0, 10);
  const grouped = new Map<ChainId, string[]>();
  for (const signal of signals) {
    const addresses = grouped.get(signal.chainId!) ?? [];
    if (!addresses.includes(signal.tokenAddress!)) addresses.push(signal.tokenAddress!);
    grouped.set(signal.chainId!, addresses);
  }

  const provider = getMarketDataProvider();
  const refreshed = new Map<string, MarketSnapshot>();
  await Promise.allSettled([...grouped.entries()].map(async ([chainId, addresses]) => {
    const markets = await provider.getTokenMarkets(chainId, addresses.slice(0, 100));
    for (const market of markets) {
      refreshed.set(marketKey(market.chainId, market.tokenAddress), market);
    }
  }));
  await Promise.allSettled(externalSignals.map(async (signal) => {
    const market = await resolveDexScreenerToken(signal.tokenAddress!, signal.dexScreenerChainId!);
    storeResolvedSignal(signal, market);
  }));

  for (const signal of signals) {
    const market = refreshed.get(marketKey(signal.chainId!, signal.tokenAddress!));
    if (!market) continue;
    store.upsertSocialTokenSignal({
      ...signal,
      dexScreenerChainId: DEXSCREENER_SLUG_BY_CHAIN[market.chainId] ?? signal.dexScreenerChainId,
      tokenSymbol: market.tokenSymbol,
      priceUsd: market.priceUsd,
      liquidityUsd: market.liquidityUsd,
      volume24hUsd: market.volume24hUsd,
      priceChange24hPercent: market.priceChange24hPercent,
      marketCapUsd: market.marketCapUsd ?? market.fdvUsd,
      pairAddress: market.pairAddress,
      resolverVersion: SOCIAL_MARKET_RESOLVER_VERSION,
      updatedAt: market.fetchedAt,
    });
  }
}

export async function ensureTelegramUserSignalService() {
  const settings = store.getTelegramSocialSettings();
  if (!settings.enabled || !settings.selectedChatIds.length) {
    removeHandler();
    stopSocialAiBatch();
    return;
  }
  try {
    await ensureConnected();
    scheduleSocialAiBatch();
    void runSocialAiBatchOnce();
    const current = state();
    const selectionKey = [...settings.selectedChatIds].sort().join(",");
    if (current.selectionKey === selectionKey && current.handler) return;

    const dialogs = await current.client!.getDialogs({ limit: 250 });
    const selected = dialogs.filter((dialog) => settings.selectedChatIds.includes(String(dialog.id)));
    current.chatTitles = new Map(selected.map((dialog) => [
      String(dialog.id),
      dialog.title || dialog.name || "Telegram kaynağı",
    ]));
    removeHandler();
    if (!selected.length) return;

    const handler = async (event: NewMessageEvent) => {
      const chatId = String(event.chatId ?? "");
      if (!settings.selectedChatIds.includes(chatId)) return;
      const message = event.message;
      const text = typeof message.message === "string" ? message.message : "";
      if (!text) return;
      const references = extractSocialTokenReferences(text);
      if (!references.length) return;
      const chatTitle = current.chatTitles.get(chatId) ?? "Telegram kaynağı";
      const messageId = String(message.id);
      // Ham mesaj bu çağrı sonrasında tutulmaz; yalnızca çıkarılan piyasa referansları işlenir.
      await Promise.allSettled(references.map((reference) => processReference({
        chatId,
        chatTitle,
        messageId,
        reference,
      })));
    };
    const eventBuilder = new NewMessage({ incoming: true });
    current.client!.addEventHandler(handler, eventBuilder);
    current.handler = handler;
    current.eventBuilder = eventBuilder;
    current.selectionKey = selectionKey;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Telegram kullanıcı bağlantısı kurulamadı.";
    state().status = { ...state().status, connected: false, lastError: message };
    recordServiceHealth("telegram_user", 0, message);
  }
}

export async function runSocialAiBatch(now = Date.now()) {
  const settings = store.getTelegramSocialSettings();
  if (!settings.enabled || store.getAiRequestUsageToday("social_signal") >= settings.dailyAiLimit) return;
  const windowEnd = Math.floor(now / SOCIAL_AI_BATCH_INTERVAL_MS) * SOCIAL_AI_BATCH_INTERVAL_MS;
  const windowStart = windowEnd - SOCIAL_AI_BACKLOG_MS;
  if (windowStart <= 0) return;

  await refreshSocialSignalMarkets();
  const signals = store.listSocialTokenSignals(500);
  const tickerCounts = new Map<string, number>();
  for (const signal of signals) {
    const createdAt = Date.parse(signal.createdAt);
    if (
      signal.referenceType !== "ticker"
      || !signal.ticker
      || createdAt < windowStart
      || createdAt >= windowEnd
    ) continue;
    const ticker = signal.ticker.toLocaleUpperCase("en-US");
    tickerCounts.set(ticker, (tickerCounts.get(ticker) ?? 0) + 1);
  }
  if (!tickerCounts.size) return;

  const signalById = new Map(signals.map((signal) => [signal.id, signal]));
  const recentAdvisorySignals = store.listAiTradeAdvisories(300)
    .filter((advisory) =>
      advisory.sourceReference.startsWith("social:")
      && now - Date.parse(advisory.createdAt) < 6 * 60 * 60 * 1_000
    )
    .map((advisory) => signalById.get(advisory.sourceReference.replace(/^social:/, "")))
    .filter((signal): signal is SocialTokenSignal => Boolean(signal));
  const candidates = new Map<string, { signal: SocialTokenSignal; market: MarketSnapshot; mentions: number }>();
  for (const signal of signals) {
    if (
      signal.status !== "analyzed"
      || !signal.chainId
      || !signal.tokenAddress
      || !signal.tokenSymbol
    ) continue;
    const mentions = tickerCounts.get(signal.tokenSymbol.toLocaleUpperCase("en-US")) ?? 0;
    if (!mentions) continue;
    const market = signalMarketSnapshot(signal);
    if (!shouldRequestSocialAi(market, signal.id, recentAdvisorySignals, now)) continue;
    const key = marketKey(signal.chainId, signal.tokenAddress);
    if (!candidates.has(key)) candidates.set(key, { signal, market, mentions });
  }

  const selected = [...candidates.values()].sort((left, right) =>
    right.mentions - left.mentions
    || right.market.liquidityUsd - left.market.liquidityUsd
    || right.market.volume24hUsd - left.market.volume24hUsd
  )[0];
  if (!selected) return;

  const dexScreenerChainId = selected.signal.dexScreenerChainId
    ?? DEXSCREENER_SLUG_BY_CHAIN[selected.market.chainId];
  const projectResearch = dexScreenerChainId && selected.market.pairAddress
    ? await collectSocialProjectResearch({
      dexScreenerChainId,
      pairAddress: selected.market.pairAddress,
    }).catch(() => ({
      website: { url: null, reachable: false, title: null, description: null },
      xProfiles: [],
      evidenceLimitations: ["Proje araştırma kaynaklarına şu anda erişilemedi."],
    }))
    : {
      website: { url: null, reachable: false, title: null, description: null },
      xProfiles: [],
      evidenceLimitations: ["DexScreener pair bilgisi olmadığı için proje araştırması yapılamadı."],
    };

  const advisoryStored = await queueTradeAdvisory({
    signalSource: "social_market_trigger",
    purpose: "social_signal",
    purposeDailyLimit: settings.dailyAiLimit,
    chainId: selected.market.chainId,
    mode: store.getMode(),
    side: "buy",
    asset: selected.market.tokenSymbol,
    walletId: null,
    walletLabel: `Telegram · ${selected.signal.chatTitle}`,
    sourceReference: `social:${selected.signal.id}`,
    walletScore: 0,
    walletConfirmations: selected.mentions,
    priceUsd: selected.market.priceUsd,
    priceChange24hPercent: selected.market.priceChange24hPercent,
    liquidityUsd: selected.market.liquidityUsd,
    volume24hUsd: selected.market.volume24hUsd,
    marketCapUsd: selected.market.marketCapUsd ?? selected.market.fdvUsd,
    safetyScore: 50,
    safetyWarnings: [
      `Son 6 saatlik birikimde ${selected.mentions} ticker paylaşımı toplandı; değerlendirme 15 dakikalık toplu çalışmada yapıldı.`,
      "Ham Telegram mesajı ve gönderen bilgisi AI'a aktarılmadı.",
    ],
    projectResearch,
  });
  if (advisoryStored === false) {
    throw new Error(`${selected.market.tokenSymbol} için AI görüşü üretilemedi.`);
  }
}

function removeHandler() {
  const current = state();
  if (current.client && current.handler && current.eventBuilder) {
    current.client.removeEventHandler(current.handler, current.eventBuilder);
  }
  current.handler = null;
  current.eventBuilder = null;
  current.selectionKey = "";
}

function scheduleSocialAiBatch() {
  const current = state();
  if (current.aiBatchTimer) return;
  const delay = SOCIAL_AI_BATCH_INTERVAL_MS - (Date.now() % SOCIAL_AI_BATCH_INTERVAL_MS) + 250;
  current.aiBatchTimer = setTimeout(async () => {
    current.aiBatchTimer = null;
    await runSocialAiBatchOnce();
    if (store.getTelegramSocialSettings().enabled) scheduleSocialAiBatch();
  }, delay);
  current.aiBatchTimer.unref?.();
}

function runSocialAiBatchOnce(now = Date.now()) {
  const current = state();
  const batchWindow = Math.floor(now / SOCIAL_AI_BATCH_INTERVAL_MS) * SOCIAL_AI_BATCH_INTERVAL_MS;
  if (current.aiBatchWindow === batchWindow) return current.aiBatchRunning ?? Promise.resolve();
  if (current.aiBatchRunning) return current.aiBatchRunning;

  current.aiBatchWindow = batchWindow;
  current.aiBatchRunning = runSocialAiBatch(now)
    .catch((error) => {
      current.aiBatchWindow = null;
      console.error(
        "[NERAXON] Sosyal sinyal AI toplu çalışması başarısız:",
        error instanceof Error ? error.message : "Bilinmeyen hata",
      );
    })
    .finally(() => {
      current.aiBatchRunning = null;
    });
  return current.aiBatchRunning;
}

function stopSocialAiBatch() {
  const current = state();
  if (current.aiBatchTimer) clearTimeout(current.aiBatchTimer);
  current.aiBatchTimer = null;
  current.aiBatchWindow = null;
}

async function ensureConnected() {
  const current = state();
  if (current.client?.connected) return;
  if (current.connecting) return current.connecting;
  current.connecting = connect().finally(() => {
    current.connecting = null;
  });
  return current.connecting;
}

async function connect() {
  const startedAt = performance.now();
  try {
    const [{ apiId, apiHash }, session] = await Promise.all([
      readTelegramUserCredentials(),
      readTelegramUserSession(),
    ]);
    const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
      connectionRetries: 5,
      floodSleepThreshold: 30,
      autoReconnect: true,
    });
    client.setLogLevel(LogLevel.ERROR);
    await client.connect();
    if (!await client.checkAuthorization()) throw new Error("Telegram kullanıcı oturumu yetkili değil.");
    const me = await client.getMe();
    const accountLabel = [me.firstName, me.lastName].filter(Boolean).join(" ") || "Telegram hesabı";
    state().client = client;
    state().status = {
      ...state().status,
      connected: true,
      accountLabel,
      lastConnectedAt: new Date().toISOString(),
      lastError: null,
    };
    recordServiceHealth("telegram_user", performance.now() - startedAt, null);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Telegram kullanıcı bağlantısı kurulamadı.";
    recordServiceHealth("telegram_user", performance.now() - startedAt, message);
    throw error;
  }
}

async function processReference(input: {
  chatId: string;
  chatTitle: string;
  messageId: string;
  reference: SocialTokenReference;
}) {
  const now = new Date().toISOString();
  const id = createHash("sha256")
    .update(`${input.chatId}:${input.messageId}:${input.reference.referenceType}:${input.reference.value}`)
    .digest("hex");
  if (store.listSocialTokenSignals(500).some((signal) => signal.id === id)) return;

  const baseSignal: SocialTokenSignal = {
    id,
    chatId: input.chatId,
    chatTitle: input.chatTitle,
    messageId: input.messageId,
    chainId: input.reference.chainHint,
    dexScreenerChainId: input.reference.dexScreenerChainHint
      ?? (input.reference.chainHint ? DEXSCREENER_SLUG_BY_CHAIN[input.reference.chainHint] ?? null : null),
    tokenAddress: input.reference.referenceType === "ticker" ? null : input.reference.value,
    tokenSymbol: null,
    ticker: input.reference.referenceType === "ticker" ? input.reference.value : null,
    referenceType: input.reference.referenceType,
    status: "detected",
    priceUsd: 0,
    liquidityUsd: 0,
    volume24hUsd: 0,
    priceChange24hPercent: 0,
    marketCapUsd: null,
    pairAddress: input.reference.pairAddress ?? null,
    errorMessage: null,
    resolverVersion: null,
    createdAt: now,
    updatedAt: now,
  };
  store.upsertSocialTokenSignal(baseSignal);
  state().status.lastSignalAt = now;
  if (input.reference.referenceType === "ticker") return;

  try {
    const market = input.reference.referenceType === "dexscreener_pair"
      ? await resolvePairMarket(input.reference)
      : await resolveAddressMarket(input.reference);
    storeResolvedSignal(baseSignal, market);
  } catch (error) {
    storeUnavailableSignal(baseSignal, error);
  }
}

async function resolveAddressMarket(reference: SocialTokenReference) {
  const provider = getMarketDataProvider();
  if (reference.chainHint) {
    try {
      const market = await provider.getTokenMarket(reference.chainHint, reference.value);
      return supportedSocialMarket(market);
    } catch {
      return resolveDexScreenerToken(
        reference.value,
        reference.dexScreenerChainHint ?? DEXSCREENER_SLUG_BY_CHAIN[reference.chainHint],
      );
    }
  }
  return resolveDexScreenerToken(reference.value, reference.dexScreenerChainHint);
}

async function resolvePairMarket(reference: SocialTokenReference) {
  const dexScreenerChainId = reference.dexScreenerChainHint
    ?? (reference.chainHint ? DEXSCREENER_SLUG_BY_CHAIN[reference.chainHint] : null);
  if (!dexScreenerChainId || !reference.pairAddress) throw new Error("DexScreener pair ağı belirlenemedi.");
  const response = await monitorService("dexscreener", () => fetch(
    `https://api.dexscreener.com/latest/dex/pairs/${dexScreenerChainId}/${reference.pairAddress}`,
    { signal: AbortSignal.timeout(8_000), headers: { accept: "application/json" }, cache: "no-store" },
  ));
  if (!response.ok) throw new Error(`DexScreener pair verisi alınamadı (${response.status}).`);
  const payload = await response.json() as { pairs?: DexScreenerSocialPair[] };
  const candidates = (payload.pairs ?? [])
    .map((pair) => pairToSocialMarket(pair))
    .filter((market): market is ResolvedSocialMarket => Boolean(market));
  if (!candidates.length) throw new Error("DexScreener pair tokeni çözümlenemedi.");
  return candidates.sort((left, right) => right.liquidityUsd - left.liquidityUsd)[0];
}

async function resolveDexScreenerToken(tokenAddress: string, dexScreenerChainHint?: string) {
  const response = await monitorService("dexscreener", () => fetch(
    `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(tokenAddress)}`,
    { signal: AbortSignal.timeout(8_000), headers: { accept: "application/json" }, cache: "no-store" },
  ));
  if (!response.ok) throw new Error(`DexScreener token verisi alınamadı (${response.status}).`);
  const payload = await response.json() as { pairs?: DexScreenerSocialPair[] };
  const candidates = (payload.pairs ?? [])
    .filter((pair) => !dexScreenerChainHint || pair.chainId?.toLowerCase() === dexScreenerChainHint.toLowerCase())
    .map((pair) => pairToSocialMarket(pair, tokenAddress))
    .filter((market): market is ResolvedSocialMarket => Boolean(market))
    .sort((left, right) => right.liquidityUsd - left.liquidityUsd);
  if (!candidates.length) throw new Error("DexScreener üzerinde doğrulanabilir token piyasası bulunamadı.");
  return candidates[0];
}

function supportedSocialMarket(market: MarketSnapshot): ResolvedSocialMarket {
  return {
    ...market,
    dexScreenerChainId: DEXSCREENER_SLUG_BY_CHAIN[market.chainId] ?? market.chainId,
  };
}

async function resolveAndStoreSignal(signal: SocialTokenSignal, reference: SocialTokenReference) {
  try {
    const market = reference.referenceType === "dexscreener_pair"
      ? await resolvePairMarket(reference)
      : await resolveAddressMarket(reference);
    storeResolvedSignal(signal, market);
  } catch (error) {
    storeUnavailableSignal(signal, error);
  }
}

function storeResolvedSignal(signal: SocialTokenSignal, market: ResolvedSocialMarket) {
  store.upsertSocialTokenSignal({
    ...signal,
    chainId: market.chainId,
    dexScreenerChainId: market.dexScreenerChainId,
    tokenAddress: market.tokenAddress,
    tokenSymbol: market.tokenSymbol,
    status: "analyzed",
    priceUsd: market.priceUsd,
    liquidityUsd: market.liquidityUsd,
    volume24hUsd: market.volume24hUsd,
    priceChange24hPercent: market.priceChange24hPercent,
    marketCapUsd: market.marketCapUsd ?? market.fdvUsd,
    pairAddress: market.pairAddress,
    errorMessage: null,
    resolverVersion: SOCIAL_MARKET_RESOLVER_VERSION,
    updatedAt: new Date().toISOString(),
  });
}

function storeUnavailableSignal(signal: SocialTokenSignal, error: unknown) {
  store.upsertSocialTokenSignal({
    ...signal,
    status: "market_unavailable",
    errorMessage: error instanceof Error ? error.message : "Piyasa bulunamadı.",
    resolverVersion: SOCIAL_MARKET_RESOLVER_VERSION,
    updatedAt: new Date().toISOString(),
  });
}

function referenceFromSignal(signal: SocialTokenSignal): SocialTokenReference {
  return {
    chainHint: signal.chainId,
    dexScreenerChainHint: signal.dexScreenerChainId ?? undefined,
    value: signal.referenceType === "dexscreener_pair"
      ? signal.pairAddress ?? signal.tokenAddress ?? ""
      : signal.tokenAddress ?? "",
    pairAddress: signal.pairAddress ?? undefined,
    referenceType: signal.referenceType,
  };
}

function withSelection(chats: TelegramUserChat[]) {
  const selected = new Set(store.getTelegramSocialSettings().selectedChatIds);
  return chats.map((chat) => ({ ...chat, selected: selected.has(chat.id) }));
}

function marketKey(chainId: ChainId, tokenAddress: string) {
  return `${chainId}:${chainId === "solana" ? tokenAddress.trim() : tokenAddress.trim().toLowerCase()}`;
}

function signalMarketSnapshot(signal: SocialTokenSignal): MarketSnapshot {
  return {
    chainId: signal.chainId!,
    tokenAddress: signal.tokenAddress!,
    tokenSymbol: signal.tokenSymbol ?? "TOKEN",
    priceUsd: signal.priceUsd,
    liquidityUsd: signal.liquidityUsd,
    volume24hUsd: signal.volume24hUsd,
    priceChange24hPercent: signal.priceChange24hPercent,
    marketCapUsd: signal.marketCapUsd,
    fdvUsd: signal.marketCapUsd,
    pairAddress: signal.pairAddress ?? "",
    dexId: "social",
    pairCreatedAt: null,
    fetchedAt: signal.updatedAt,
  };
}
