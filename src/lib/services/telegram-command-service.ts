import type { ChainId, ExecutionLot, HypercoreMarketType, HypercorePositionSide } from "@/lib/domain/types";
import { CHAIN_DEFINITIONS, INTEGRATION_IDS } from "@/lib/domain/defaults";
import { getNetworkExecutionLimit } from "@/lib/execution/network-execution-risk";
import { store } from "@/lib/repositories/store";
import { readCredentialSync } from "@/lib/security/credential-vault";
import { getBotOrchestrator } from "@/lib/services/bot-orchestrator";
import { getDashboardSnapshotForApi } from "@/lib/services/dashboard-service";
import { findHypercoreMarket, getHypercoreMarkets } from "@/lib/services/hypercore-api";
import { monitorService } from "@/lib/services/service-health";
import { resolveTokenQuote } from "@/lib/services/token-quote-service";
import { summarizeOpenPositionBalances } from "@/lib/telegram/balance-summary";
import { parseInfoCommand, suggestInfoCommand, type InfoCommand } from "@/lib/telegram/info-command-parser";
import { errorMessage } from "@/lib/utils/error-message";

interface TelegramUser {
  id: number;
}

interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  message_thread_id?: number;
  chat: { id: number };
  from?: TelegramUser;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface InlineButton {
  text: string;
  callback_data: string;
}

interface EvmTradeAction {
  type: "evm";
  chainId: Exclude<ChainId, "hyperliquid">;
  side: "buy" | "sell";
  asset: string;
  symbol: string;
  amountUsd?: number;
  allocationPercent?: number;
  sellPercent?: number;
}

interface HyperTradeAction {
  type: "hypercore";
  marketType: HypercoreMarketType;
  coin: string;
  side: HypercorePositionSide;
  action: "open" | "close";
  amountUsd?: number;
  allocationPercent?: number;
  closePercent?: number;
  leverage: number;
}

interface BatchSellAction {
  type: "batchSell";
  chainId: ChainId;
  positions: Array<EvmTradeAction | HyperTradeAction>;
}

interface PositionChoice {
  type: "position";
  action: EvmTradeAction | HyperTradeAction;
}

type PendingPayload = EvmTradeAction | HyperTradeAction | BatchSellAction | PositionChoice;

interface PendingAction {
  id: string;
  payload: PendingPayload;
  userId: number;
  chatId: string;
  topicId: number;
  requestId: string;
  expiresAt: number;
  consumed: boolean;
}

interface RateWindow {
  commands: number[];
  trades: number[];
}

interface TelegramConfiguration {
  token: string;
  chatId: string;
  topicId: number;
  allowedUserId: number;
}

const COMMAND_MAX_AGE_MS = 2 * 60_000;
const CONFIRMATION_TTL_MS = 60_000;
const POSITION_BUTTON_TTL_MS = 5 * 60_000;
const MAX_COMMANDS_PER_MINUTE = 12;
const MAX_TRADE_REQUESTS_PER_MINUTE = 3;
const MAX_BATCH_POSITIONS = 20;
const globalState = globalThis as typeof globalThis & {
  neraxonTelegramCommands?: TelegramCommandService;
  neraxonTelegramPendingActions?: Map<string, PendingAction>;
};

const pendingActions = globalState.neraxonTelegramPendingActions ?? new Map<string, PendingAction>();
globalState.neraxonTelegramPendingActions = pendingActions;

class TelegramCommandService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private offset = 0;
  private registeredCommandsFor = "";
  private readonly rateWindows = new Map<number, RateWindow>();

  start() {
    if (!this.timer) this.timer = setTimeout(() => void this.poll(), 1_000);
  }

  private schedule(delay = 750) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.poll(), delay);
  }

  private async poll() {
    if (this.polling) return;
    this.polling = true;
    const configuration = readConfiguration();
    if (!configuration) {
      this.polling = false;
      this.schedule(10_000);
      return;
    }
    try {
      this.expirePendingActions();
      await this.registerCommands(configuration);
      const url = `https://api.telegram.org/bot${configuration.token}/getUpdates?offset=${this.offset}&limit=50&timeout=20&allowed_updates=${encodeURIComponent(JSON.stringify(["message", "callback_query"]))}`;
      const response = await monitorService("telegram", () => fetch(url, {
        signal: AbortSignal.timeout(25_000),
        cache: "no-store",
      }));
      const payload = await response.json() as { ok: boolean; result?: TelegramUpdate[]; description?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.description || "Telegram komutları alınamadı.");
      for (const update of payload.result ?? []) {
        this.offset = Math.max(this.offset, update.update_id + 1);
        if (update.callback_query) await this.handleCallback(update.callback_query, configuration);
        else if (update.message) await this.handleMessage(update.message, configuration);
      }
    } catch {
      // Sağlık servisi hatayı kaydeder; bir sonraki poll otomatik devam eder.
    } finally {
      this.polling = false;
      this.schedule();
    }
  }

  private async handleMessage(message: TelegramMessage, configuration: TelegramConfiguration) {
    if (!this.isAuthorizedMessage(message, configuration) || !message.text) return;
    if (Date.now() - message.date * 1_000 > COMMAND_MAX_AGE_MS) return;
    const command = parseInfoCommand(message.text);
    if (!command) {
      const suggestion = suggestInfoCommand(message.text);
      if (suggestion) {
        await this.send(configuration, `Komut bulunamadı. ${suggestion} komutunu mu demek istedin?`, [[
          { text: `${suggestion} çalıştır`, callback_data: `nx:command:${suggestion.slice(1)}` },
        ]]);
      } else {
        await this.sendHelp(configuration, "Komut biçimi tanınmadı.");
      }
      return;
    }
    if (!this.consumeRateLimit(configuration.allowedUserId, isTradeCommand(command))) {
      await this.send(configuration, "Çok hızlı komut gönderildi. Bir dakika bekleyip tekrar dene.");
      return;
    }
    try {
      await this.dispatch(command, configuration);
    } catch (error) {
      this.audit("warning", "Telegram komutu başarısız", errorMessage(error));
      await this.send(configuration, `İşlem tamamlanamadı:\n${errorMessage(error)}`);
    }
  }

  private async handleCallback(callback: TelegramCallbackQuery, configuration: TelegramConfiguration) {
    const message = callback.message;
    if (
      callback.from.id !== configuration.allowedUserId
      || !message
      || String(message.chat.id) !== configuration.chatId
      || message.message_thread_id !== configuration.topicId
      || !callback.data
    ) {
      await this.answerCallback(configuration.token, callback.id, "Bu işlem için yetkin yok.");
      return;
    }

    const [prefix, operation, actionId, value] = callback.data.split(":");
    if (prefix !== "nx") return;
    if (operation === "command") {
      const command = parseInfoCommand(`/${actionId}`);
      if (!command || !this.consumeRateLimit(configuration.allowedUserId, false)) {
        await this.answerCallback(configuration.token, callback.id, "Komut çalıştırılamadı.");
        return;
      }
      await this.answerCallback(configuration.token, callback.id, `/${actionId} çalıştırılıyor.`);
      try {
        await this.dispatch(command, configuration);
      } catch (error) {
        await this.send(configuration, `Komut tamamlanamadı:\n${errorMessage(error)}`);
      }
      return;
    }
    const pending = pendingActions.get(actionId);
    if (!pending || pending.userId !== callback.from.id || pending.expiresAt <= Date.now() || pending.consumed) {
      pendingActions.delete(actionId);
      await this.answerCallback(configuration.token, callback.id, "Bu onayın süresi doldu.");
      return;
    }
    if (operation === "cancel") {
      pending.consumed = true;
      pendingActions.delete(actionId);
      this.audit("info", "Telegram emri iptal edildi", describeAction(pending.payload));
      await this.answerCallback(configuration.token, callback.id, "Emir iptal edildi.");
      await this.editReplyMarkup(configuration, message.message_id);
      await this.send(configuration, "Emir iptal edildi.");
      return;
    }
    if (operation === "position" && pending.payload.type === "position") {
      const percent = Number(value);
      if (![25, 50, 100].includes(percent)) return;
      pendingActions.delete(actionId);
      const action = withClosePercent(pending.payload.action, percent);
      await this.answerCallback(configuration.token, callback.id, `%${percent} satış seçildi.`);
      await this.createConfirmation(action, configuration);
      return;
    }
    if (operation !== "confirm") return;

    pending.consumed = true;
    await this.editReplyMarkup(configuration, message.message_id);
    await this.answerCallback(configuration.token, callback.id, "Emir yürütülüyor.");
    this.audit("warning", "Telegram emri onaylandı", describeAction(pending.payload));
    try {
      const result = await this.executePending(pending);
      await this.send(configuration, result);
    } catch (error) {
      this.audit("critical", "Telegram emri başarısız", `${describeAction(pending.payload)} · ${errorMessage(error)}`);
      await this.send(configuration, `Emir başarısız:\n${errorMessage(error)}`);
    } finally {
      pendingActions.delete(actionId);
    }
  }

  private async dispatch(command: InfoCommand, configuration: TelegramConfiguration) {
    if (command.kind === "help") return this.sendHelp(configuration);
    if (command.kind === "status") return this.sendStatus(configuration);
    if (command.kind === "balance") return this.sendBalance(configuration);
    if (command.kind === "pnl") return this.sendPnl(configuration);
    if (command.kind === "positions") return this.sendPositions(configuration);
    if (command.kind === "recent") return this.sendRecent(configuration);
    if (command.kind === "limits") return this.sendLimits(configuration);
    if (command.kind === "pause" || command.kind === "resume") {
      await Promise.all(command.chainIds.map((chainId) => command.kind === "pause"
        ? getBotOrchestrator().stop(chainId)
        : getBotOrchestrator().start(chainId)));
      this.audit("warning", `Telegram üzerinden bot ${command.kind === "pause" ? "durduruldu" : "çalıştırıldı"}`, command.chainIds.join(", "));
      return this.send(configuration, `${command.chainIds.map((chainId) => CHAIN_DEFINITIONS[chainId].name).join(", ")} ${command.kind === "pause" ? "durduruldu" : "çalıştırıldı"}.`);
    }
    if (command.kind === "quote") return this.sendTokenQuote(command.chainId, command.asset, configuration);
    if (command.kind === "hyperQuote") return this.sendHyperQuote(command.marketType, command.coin, configuration);
    if (command.kind === "buy") return this.prepareBuy(command, configuration);
    if (command.kind === "hyperBuy") return this.prepareHyperBuy(command, configuration);
    if (command.kind === "sell") return this.prepareSell(command, configuration);
    if (command.kind === "hyperSell") return this.prepareHyperSell(command, configuration);
    if (command.kind === "sellAll") return this.prepareSellAll(command.chainId, configuration);
    return this.sendHelp(configuration);
  }

  private async sendStatus(configuration: TelegramConfiguration) {
    const snapshot = await getDashboardSnapshotForApi();
    const lines = snapshot.chains.map((chain) => {
      const status = chain.status === "running" ? "Çalışıyor" : chain.status === "error" ? "Hata" : "Durdu";
      return `${CHAIN_DEFINITIONS[chain.id].name}: ${status} · ${chain.latencyMs ?? "-"} ms`;
    });
    await this.send(configuration, `NERAXON · ${snapshot.mode.toUpperCase()}\n\n${lines.join("\n")}`);
  }

  private async sendBalance(configuration: TelegramConfiguration) {
    const snapshot = await getDashboardSnapshotForApi();
    const accounts = snapshot.mode === "live" ? snapshot.livePortfolio : snapshot.shadowPortfolio;
    const lines = accounts.map((account) => {
      const lots = snapshot.executionLots.filter((lot) => (
        lot.mode === snapshot.mode
        && lot.integrationId === account.integrationId
        && lot.status === "open"
      ));
      const positions = summarizeOpenPositionBalances(lots);
      if (account.integrationId === "hyperliquid") {
        return `Hyperliquid: ${money(account.equityUsd)} · kullanılabilir ${money(account.cashBalanceUsd)} · teminat ${money(positions.allocatedCapitalUsd)} · ${positions.positionCount} poz.`;
      }
      return `${CHAIN_DEFINITIONS[account.integrationId].name}: ${money(account.equityUsd)}${positions.positionCount ? ` · ${positions.positionCount} poz.` : ""}`;
    });
    const netPnl = snapshot.realizedPnlUsd + snapshot.unrealizedPnlUsd;
    await this.send(configuration,
      `NERAXON BAKİYE\n`
      + `Toplam portföy: ${money(snapshot.equityUsd)}\n`
      + `Toplam kullanılabilir: ${money(snapshot.cashBalanceUsd)}\n`
      + `Net PnL: ${signedMoney(netPnl)}\n\n`
      + `${lines.join("\n") || "Ağ bakiyesi alınamadı."}`,
    );
  }

  private async sendPnl(configuration: TelegramConfiguration) {
    const snapshot = await getDashboardSnapshotForApi();
    const netPnl = snapshot.realizedPnlUsd + snapshot.unrealizedPnlUsd;
    await this.send(configuration,
      `Net PnL: ${signedMoney(netPnl)}\n`
      + `Gerçekleşen: ${signedMoney(snapshot.realizedPnlUsd)}\n`
      + `Gerçekleşmemiş: ${signedMoney(snapshot.unrealizedPnlUsd)}\n`
      + `Bugün: ${signedMoney(snapshot.dailyPnlUsd)}\n`
      + `Toplam maliyet: ${money(snapshot.totalFeesUsd)}`,
    );
  }

  private async sendPositions(configuration: TelegramConfiguration) {
    const positions = openPositionActions();
    if (!positions.length) {
      await this.send(configuration, "Açık pozisyon yok.");
      return;
    }
    const lines: string[] = [];
    const keyboard: InlineButton[][] = [];
    for (const [index, position] of positions.slice(0, MAX_BATCH_POSITIONS).entries()) {
      const id = this.storePending({ type: "position", action: position.action }, configuration, POSITION_BUTTON_TTL_MS);
      lines.push(`${index + 1}. ${position.label}`);
      keyboard.push([
        { text: `${position.symbol} %25`, callback_data: `nx:position:${id}:25` },
        { text: "%50", callback_data: `nx:position:${id}:50` },
        { text: "%100", callback_data: `nx:position:${id}:100` },
      ]);
    }
    await this.send(configuration, `Açık pozisyonlar\n\n${lines.join("\n")}`, keyboard);
  }

  private async sendRecent(configuration: TelegramConfiguration) {
    const attempts = store.listExecutionAttempts(8);
    const lines = attempts.map((attempt) => {
      const state = attempt.status === "confirmed" ? "Tamamlandı" : attempt.status === "failed" ? "Başarısız" : attempt.status;
      return `${CHAIN_DEFINITIONS[attempt.integrationId].name} · ${attempt.asset} · ${attempt.action} · ${state}\n${shortDate(attempt.createdAt)}`;
    });
    await this.send(configuration, lines.length ? `Son emirler\n\n${lines.join("\n\n")}` : "Henüz execution kaydı yok.");
  }

  private async sendLimits(configuration: TelegramConfiguration) {
    const settings = store.getRiskSettings();
    const lines = INTEGRATION_IDS.map((chainId) => {
      const limit = getNetworkExecutionLimit(chainId, settings);
      return `${CHAIN_DEFINITIONS[chainId].name}: ${money(limit.minTradeUsd)}–${money(limit.maxTradeUsd)} · %${limit.minPositionPercent}–%${limit.maxPositionPercent} · slippage %${limit.maxSlippagePercent}`;
    });
    await this.send(configuration, `Canlı işlem limitleri\n\n${lines.join("\n")}`);
  }

  private async sendTokenQuote(chainId: Exclude<ChainId, "hyperliquid">, asset: string, configuration: TelegramConfiguration) {
    const quote = await resolveTokenQuote(chainId, asset);
    await this.send(configuration, formatTokenQuote(quote));
  }

  private async sendHyperQuote(marketType: HypercoreMarketType, coin: string, configuration: TelegramConfiguration) {
    const market = findHypercoreMarket(await getHypercoreMarkets(), marketType, coin);
    if (!market) throw new Error("HyperCore piyasası bulunamadı.");
    await this.send(configuration,
      `${market.symbol} · ${market.marketType.toUpperCase()}\n`
      + `Fiyat: ${money(market.priceUsd)}\n`
      + `24s: ${signedPercent(market.priceChange24hPercent)}\n`
      + `Hacim: ${money(market.volume24hUsd)}\n`
      + `Açık pozisyon: ${money(market.openInterestUsd)}\n`
      + `Maksimum kaldıraç: ${market.maxLeverage}x`,
    );
  }

  private async prepareBuy(command: Extract<InfoCommand, { kind: "buy" }>, configuration: TelegramConfiguration) {
    this.assertLiveMode();
    const [quote, snapshot] = await Promise.all([
      resolveTokenQuote(command.chainId, command.asset),
      getDashboardSnapshotForApi(),
    ]);
    if (!quote.safety.approved) throw new Error(quote.safety.reason);
    const allocationPercent = allocationForUsd(command.chainId, command.amountUsd, snapshot, 1);
    await this.createConfirmation({
      type: "evm",
      chainId: command.chainId,
      side: "buy",
      asset: quote.address,
      symbol: quote.symbol,
      amountUsd: command.amountUsd,
      allocationPercent,
    }, configuration, formatTokenQuote(quote));
  }

  private async prepareHyperBuy(command: Extract<InfoCommand, { kind: "hyperBuy" }>, configuration: TelegramConfiguration) {
    this.assertLiveMode();
    const [markets, snapshot] = await Promise.all([getHypercoreMarkets(), getDashboardSnapshotForApi()]);
    const market = findHypercoreMarket(markets, command.marketType, command.coin);
    if (!market) throw new Error("HyperCore piyasası bulunamadı.");
    if (command.leverage > market.maxLeverage) throw new Error(`Bu piyasa en fazla ${market.maxLeverage}x kaldıraç destekliyor.`);
    const allocationPercent = allocationForUsd("hyperliquid", command.amountUsd, snapshot, command.leverage);
    await this.createConfirmation({
      type: "hypercore",
      marketType: command.marketType,
      coin: market.key,
      side: command.side,
      action: "open",
      amountUsd: command.amountUsd,
      allocationPercent,
      leverage: command.leverage,
    }, configuration, `Fiyat: ${money(market.priceUsd)} · 24s ${signedPercent(market.priceChange24hPercent)} · Hacim ${money(market.volume24hUsd)}`);
  }

  private async prepareSell(command: Extract<InfoCommand, { kind: "sell" }>, configuration: TelegramConfiguration) {
    this.assertLiveMode();
    const lot = findOpenLot(command.chainId, command.asset);
    if (!lot) throw new Error("Bu token için açık canlı pozisyon bulunamadı.");
    await this.createConfirmation({
      type: "evm",
      chainId: command.chainId,
      side: "sell",
      asset: lot.assetKey,
      symbol: lot.assetSymbol || "TOKEN",
      sellPercent: command.percent,
    }, configuration);
  }

  private async prepareHyperSell(command: Extract<InfoCommand, { kind: "hyperSell" }>, configuration: TelegramConfiguration) {
    this.assertLiveMode();
    const lot = findOpenHyperLot(command.marketType, command.coin, command.side);
    if (!lot) throw new Error("Bu HyperCore piyasası için açık canlı pozisyon bulunamadı.");
    await this.createConfirmation({
      type: "hypercore",
      marketType: command.marketType,
      coin: lot.assetSymbol || command.coin,
      side: command.side,
      action: "close",
      closePercent: command.percent,
      leverage: lot.leverage || 1,
    }, configuration);
  }

  private async prepareSellAll(chainId: ChainId, configuration: TelegramConfiguration) {
    this.assertLiveMode();
    const positions = openPositionActions()
      .filter((position) => position.chainId === chainId)
      .slice(0, MAX_BATCH_POSITIONS)
      .map((position) => withClosePercent(position.action, 100));
    if (!positions.length) throw new Error(`${CHAIN_DEFINITIONS[chainId].name} ağında açık pozisyon yok.`);
    await this.createConfirmation({ type: "batchSell", chainId, positions }, configuration);
  }

  private async createConfirmation(
    payload: EvmTradeAction | HyperTradeAction | BatchSellAction,
    configuration: TelegramConfiguration,
    quoteText?: string,
  ) {
    const id = this.storePending(payload, configuration, CONFIRMATION_TTL_MS);
    const details = describeAction(payload);
    this.audit("info", "Telegram emri onay bekliyor", details);
    await this.send(configuration,
      `Onay gerekiyor\n\n${details}${quoteText ? `\n${quoteText}` : ""}\n\nSüre: 60 saniye`,
      [[
        { text: "Onayla", callback_data: `nx:confirm:${id}` },
        { text: "İptal", callback_data: `nx:cancel:${id}` },
      ]],
    );
  }

  private async executePending(pending: PendingAction) {
    if (pending.payload.type === "batchSell") {
      const results: string[] = [];
      for (const action of pending.payload.positions) {
        try {
          await executeTradeAction(action, crypto.randomUUID());
          results.push(`${actionSymbol(action)}: tamamlandı`);
        } catch (error) {
          results.push(`${actionSymbol(action)}: ${errorMessage(error)}`);
        }
      }
      return `Toplu satış sonucu\n\n${results.join("\n")}`;
    }
    if (pending.payload.type === "position") throw new Error("Pozisyon için satış yüzdesi seçilmedi.");
    await executeTradeAction(pending.payload, pending.requestId);
    return `${describeAction(pending.payload)}\n\nEmir execution motoru tarafından tamamlandı.`;
  }

  private storePending(payload: PendingPayload, configuration: TelegramConfiguration, ttlMs: number) {
    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    pendingActions.set(id, {
      id,
      payload,
      userId: configuration.allowedUserId,
      chatId: configuration.chatId,
      topicId: configuration.topicId,
      requestId: crypto.randomUUID(),
      expiresAt: Date.now() + ttlMs,
      consumed: false,
    });
    return id;
  }

  private expirePendingActions() {
    for (const [id, pending] of pendingActions) {
      if (pending.expiresAt <= Date.now() || pending.consumed) pendingActions.delete(id);
    }
  }

  private consumeRateLimit(userId: number, trade: boolean) {
    const now = Date.now();
    const cutoff = now - 60_000;
    const window = this.rateWindows.get(userId) ?? { commands: [], trades: [] };
    window.commands = window.commands.filter((timestamp) => timestamp > cutoff);
    window.trades = window.trades.filter((timestamp) => timestamp > cutoff);
    if (window.commands.length >= MAX_COMMANDS_PER_MINUTE || (trade && window.trades.length >= MAX_TRADE_REQUESTS_PER_MINUTE)) return false;
    window.commands.push(now);
    if (trade) window.trades.push(now);
    this.rateWindows.set(userId, window);
    return true;
  }

  private isAuthorizedMessage(message: TelegramMessage, configuration: TelegramConfiguration) {
    return String(message.chat.id) === configuration.chatId
      && message.message_thread_id === configuration.topicId
      && message.from?.id === configuration.allowedUserId;
  }

  private assertLiveMode() {
    if (store.getMode() !== "live") throw new Error("Telegram üzerinden emir yalnızca live modda verilebilir.");
    if (process.env.LIVE_TRADING_ENABLED?.trim().toLowerCase() !== "true") throw new Error("Canlı işlem anahtarı kapalı.");
  }

  private audit(level: "info" | "warning" | "critical", title: string, message: string) {
    store.insertEvent({
      id: crypto.randomUUID(),
      chainId: null,
      level,
      type: "system",
      title,
      message,
      txHash: null,
      createdAt: new Date().toISOString(),
    });
  }

  private async sendHelp(configuration: TelegramConfiguration, prefix?: string) {
    await this.send(configuration,
      `${prefix ? `${prefix}\n\n` : ""}NERAXON Info komutları\n\n`
      + `/balance · Ağ bakiyeleri\n`
      + `/pnl · Güncel kar/zarar\n`
      + `/positions · Açık pozisyonlar ve satış butonları\n`
      + `/status · Bot ve RPC durumu\n`
      + `/recent · Son execution kayıtları\n`
      + `/limits · Ağ işlem limitleri\n`
      + `/quote base <CA>\n`
      + `/buy base <CA> <USD>\n`
      + `/sell base <CA> <yüzde>\n`
      + `/buy hyperliquid spot HYPE <USD>\n`
      + `/buy hyperliquid perp HYPE long <USD> <kaldıraç>\n`
      + `/sell hyperliquid perp HYPE long <yüzde>\n`
      + `/sellall base\n`
      + `/pause base|all · /resume base|all\n\n`
      + `Ağ kısaltmaları: eth, base, rhc, sol, hl`,
    );
  }

  private async send(configuration: TelegramConfiguration, text: string, keyboard?: InlineButton[][]) {
    const body: Record<string, unknown> = {
      chat_id: configuration.chatId,
      message_thread_id: configuration.topicId,
      text,
      disable_web_page_preview: true,
    };
    if (keyboard?.length) body.reply_markup = { inline_keyboard: keyboard };
    const response = await fetch(`https://api.telegram.org/bot${configuration.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`Telegram yanıtı gönderilemedi (${response.status}).`);
  }

  private async answerCallback(token: string, callbackQueryId: string, text: string) {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
      signal: AbortSignal.timeout(8_000),
    }).catch(() => undefined);
  }

  private async editReplyMarkup(configuration: TelegramConfiguration, messageId: number) {
    await fetch(`https://api.telegram.org/bot${configuration.token}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: configuration.chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
      signal: AbortSignal.timeout(8_000),
    }).catch(() => undefined);
  }

  private async registerCommands(configuration: TelegramConfiguration) {
    const registrationKey = `${configuration.chatId}:${configuration.topicId}`;
    if (this.registeredCommandsFor === registrationKey) return;
    const commands = [
      { command: "balance", description: "Güncel bakiye özeti" },
      { command: "pnl", description: "Güncel kar ve zarar" },
      { command: "positions", description: "Açık pozisyonlar" },
      { command: "status", description: "Bot ve ağ durumu" },
      { command: "recent", description: "Son execution kayıtları" },
      { command: "limits", description: "Canlı işlem limitleri" },
      { command: "quote", description: "Token fiyat ve güvenlik bilgisi" },
      { command: "buy", description: "Onaylı canlı alım hazırla" },
      { command: "sell", description: "Onaylı canlı satış hazırla" },
      { command: "sellall", description: "Bir ağdaki pozisyonları kapat" },
      { command: "pause", description: "Ağ botunu durdur" },
      { command: "resume", description: "Ağ botunu çalıştır" },
      { command: "help", description: "Komut kullanımını göster" },
    ];
    const response = await fetch(`https://api.telegram.org/bot${configuration.token}/setMyCommands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commands,
        scope: { type: "chat", chat_id: configuration.chatId },
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return;
    this.registeredCommandsFor = registrationKey;
  }
}

function readConfiguration(): TelegramConfiguration | null {
  const token = readCredentialSync("telegram-bot-token");
  const chatId = readCredentialSync("telegram-chat-id");
  const topicId = Number(process.env.TELEGRAM_INFO_TOPIC_ID);
  const allowedUserId = Number(process.env.TELEGRAM_ALLOWED_USER_ID);
  if (!token || !chatId || !Number.isSafeInteger(topicId) || topicId <= 0 || !Number.isSafeInteger(allowedUserId) || allowedUserId <= 0) return null;
  return { token, chatId, topicId, allowedUserId };
}

function isTradeCommand(command: InfoCommand) {
  return ["buy", "hyperBuy", "sell", "hyperSell", "sellAll"].includes(command.kind);
}

function allocationForUsd(chainId: ChainId, amountUsd: number, snapshot: Awaited<ReturnType<typeof getDashboardSnapshotForApi>>, leverage: number) {
  const account = snapshot.livePortfolio.find((item) => item.integrationId === chainId);
  if (!account || account.equityUsd <= 0) throw new Error(`${CHAIN_DEFINITIONS[chainId].name} canlı bakiyesi alınamadı.`);
  const limit = getNetworkExecutionLimit(chainId, store.getRiskSettings());
  if (amountUsd + 0.01 < limit.minTradeUsd || amountUsd > limit.maxTradeUsd + 0.01) {
    throw new Error(`İzin verilen emir değeri ${money(limit.minTradeUsd)}–${money(limit.maxTradeUsd)}.`);
  }
  const allocationPercent = amountUsd / Math.max(0.01, account.cashBalanceUsd) / Math.max(1, leverage) * 100;
  const routeMaximum = chainId === "hyperliquid" ? Math.min(25, limit.maxPositionPercent) : limit.maxPositionPercent;
  if (allocationPercent + 0.01 < limit.minPositionPercent || allocationPercent > routeMaximum + 0.01) {
    const minimumUsd = account.cashBalanceUsd * limit.minPositionPercent / 100 * Math.max(1, leverage);
    const maximumUsd = account.cashBalanceUsd * routeMaximum / 100 * Math.max(1, leverage);
    throw new Error(`Mevcut bakiyeye göre tutar ${money(minimumUsd)}–${money(Math.min(limit.maxTradeUsd, maximumUsd))} aralığında olmalı.`);
  }
  return Math.min(routeMaximum, Math.max(limit.minPositionPercent, allocationPercent));
}

function openPositionActions() {
  const mode = store.getMode();
  if (mode === "paper") return [];
  const grouped = new Map<string, ExecutionLot[]>();
  for (const lot of store.listExecutionLots(mode).filter((item) => item.status === "open")) {
    const key = `${lot.integrationId}:${lot.assetKey}:${lot.positionSide ?? ""}`;
    grouped.set(key, [...(grouped.get(key) ?? []), lot]);
  }
  return [...grouped.values()].map((lots) => {
    const first = lots[0];
    const action: EvmTradeAction | HyperTradeAction = first.integrationId === "hyperliquid"
      ? {
          type: "hypercore",
          marketType: first.marketType as HypercoreMarketType,
          coin: first.assetSymbol || first.assetKey.replace(/^(spot|perp):/i, ""),
          side: first.positionSide ?? "long",
          action: "close",
          closePercent: 100,
          leverage: first.leverage || 1,
        }
      : {
          type: "evm",
          chainId: first.integrationId,
          side: "sell",
          asset: first.assetKey,
          symbol: first.assetSymbol || "TOKEN",
          sellPercent: 100,
        };
    const pnl = lots.reduce((sum, lot) => sum + lotPnl(lot), 0);
    return {
      chainId: first.integrationId,
      symbol: first.assetSymbol || first.assetKey,
      action,
      label: `${CHAIN_DEFINITIONS[first.integrationId].name} · ${first.assetSymbol || first.assetKey} · ${signedMoney(pnl)}`,
    };
  });
}

function findOpenLot(chainId: Exclude<ChainId, "hyperliquid">, asset: string) {
  const normalized = asset.trim().toLowerCase();
  return store.listExecutionLots("live", chainId).find((lot) => lot.status === "open" && (
    lot.assetKey.toLowerCase() === normalized || lot.assetSymbol.toLowerCase() === normalized
  )) ?? null;
}

function findOpenHyperLot(marketType: HypercoreMarketType, coin: string, side: HypercorePositionSide) {
  const normalizedCoin = coin.trim().toLowerCase();
  return store.listExecutionLots("live", "hyperliquid").find((lot) => (
    lot.status === "open"
    && lot.marketType === marketType
    && lot.positionSide === side
    && (lot.assetSymbol.toLowerCase() === normalizedCoin || lot.assetKey.toLowerCase() === `${marketType}:${normalizedCoin}`)
  )) ?? null;
}

function withClosePercent(action: EvmTradeAction | HyperTradeAction, percent: number): EvmTradeAction | HyperTradeAction {
  return action.type === "evm" ? { ...action, sellPercent: percent } : { ...action, closePercent: percent };
}

async function executeTradeAction(action: EvmTradeAction | HyperTradeAction, requestId: string) {
  const url = action.type === "evm" ? "http://127.0.0.1/api/trades/manual" : "http://127.0.0.1/api/trades/hypercore/manual";
  const body = action.type === "evm"
    ? {
        chainId: action.chainId,
        side: action.side,
        tokenAddress: action.asset,
        allocationPercent: action.allocationPercent,
        sellPercent: action.sellPercent,
        requestId,
      }
    : {
        coin: action.coin,
        marketType: action.marketType,
        positionSide: action.side,
        action: action.action,
        allocationPercent: action.allocationPercent,
        closePercent: action.closePercent,
        leverage: action.leverage,
        requestId,
      };
  const request = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", host: "127.0.0.1", origin: "http://127.0.0.1" },
    body: JSON.stringify(body),
  });
  const route = action.type === "evm"
    ? await import("@/app/api/trades/manual/route")
    : await import("@/app/api/trades/hypercore/manual/route");
  const response = await route.POST(request);
  const payload = await response.json() as { error?: string; execution?: { status?: string; txHash?: string | null; orderId?: string | null } };
  if (!response.ok) throw new Error(payload.error || `Execution isteği başarısız (${response.status}).`);
  return payload;
}

function formatTokenQuote(quote: Awaited<ReturnType<typeof resolveTokenQuote>>) {
  return `${quote.symbol} · ${CHAIN_DEFINITIONS[quote.chainId].name}\n`
    + `Fiyat: ${money(quote.market.priceUsd)}\n`
    + `Piyasa değeri: ${money(quote.market.marketCapUsd ?? 0)}\n`
    + `Likidite: ${money(quote.market.liquidityUsd)}\n`
    + `24s hacim: ${money(quote.market.volume24hUsd)}\n`
    + `24s değişim: ${signedPercent(quote.market.priceChange24hPercent)}\n`
    + `Güvenlik: ${quote.safety.score}/100 · ${quote.safety.approved ? "Uygun" : quote.safety.reason}`;
}

function describeAction(payload: PendingPayload): string {
  if (payload.type === "position") return describeAction(payload.action);
  if (payload.type === "batchSell") return `${CHAIN_DEFINITIONS[payload.chainId].name} · ${payload.positions.length} açık pozisyonun tamamını sat`;
  if (payload.type === "evm") {
    return `${CHAIN_DEFINITIONS[payload.chainId].name} · ${payload.symbol} · ${payload.side === "buy" ? `${money(payload.amountUsd ?? 0)} al` : `%${payload.sellPercent ?? 100} sat`}`;
  }
  return `Hyperliquid · ${payload.marketType.toUpperCase()} ${payload.coin} ${payload.side} · ${payload.action === "open" ? `${money(payload.amountUsd ?? 0)} aç · ${payload.leverage}x` : `%${payload.closePercent ?? 100} kapat`}`;
}

function actionSymbol(action: EvmTradeAction | HyperTradeAction) {
  return action.type === "evm" ? action.symbol : action.coin;
}

function lotPnl(lot: ExecutionLot) {
  const quantity = lot.amountFormat === "base_units"
    ? Number(lot.amount) / 10 ** lot.assetDecimals
    : Number(lot.amount);
  const direction = lot.positionSide === "short" ? -1 : 1;
  return (lot.currentPriceUsd - lot.entryPriceUsd) * quantity * direction;
}

function money(value: number) {
  return `$${Number.isFinite(value) ? value.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "0,00"}`;
}

function signedMoney(value: number) {
  return `${value >= 0 ? "+" : "-"}${money(Math.abs(value))}`;
}

function signedPercent(value: number) {
  return `${value >= 0 ? "+" : ""}%${value.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function shortDate(value: string) {
  return new Intl.DateTimeFormat("tr-TR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Istanbul" }).format(new Date(value));
}

export function startTelegramCommandService() {
  const service = (globalState.neraxonTelegramCommands ??= new TelegramCommandService());
  service.start();
}
