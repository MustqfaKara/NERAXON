import type { AppLanguage, AuditEvent, ExecutionAttempt } from "@/lib/domain/types";
import { translateText } from "@/lib/i18n";
import { store } from "@/lib/repositories/store";
import { monitorService } from "@/lib/services/service-health";
import { CHAIN_DEFINITIONS } from "@/lib/domain/defaults";
import { escapeHtml, splitTelegramMessage } from "@/lib/engine/telegram-message";
import { readCredentialSync } from "@/lib/security/credential-vault";
import { integrationMarketUrl } from "@/lib/domain/integrations";
import { isCompletedTradeNotification, isImportantNotification } from "@/lib/engine/telegram-notification-routing";

export interface NotificationProvider {
  send(event: AuditEvent): Promise<void>;
}

class TelegramNotificationProvider implements NotificationProvider {
  async send(event: AuditEvent) {
    const token = readCredentialSync("telegram-bot-token");
    const chatId = readCredentialSync("telegram-chat-id");
    if (!token || !chatId) return;

    const language = store.getLanguage();
    const generalTopicId = topicId("TELEGRAM_GENERAL_TOPIC_ID");
    const tradeTopicId = topicId("TELEGRAM_TRADES_TOPIC_ID");
    const importantTopicId = topicId("TELEGRAM_IMPORTANT_TOPIC_ID");
    const attempt = isCompletedTradeNotification(event) ? findExecutionAttempt(event) : null;

    if (attempt && tradeTopicId) {
      await sendTelegramMessage({
        token,
        chatId,
        topicId: tradeTopicId,
        text: formatTradeNotification(attempt, event, language),
        disableNotification: false,
        buttons: tradeButtons(attempt, language),
      });
    }

    if (isImportantNotification(event) && importantTopicId) {
      await sendEventMessages({ token, chatId, topicId: importantTopicId, event, language, disableNotification: false });
    }

    await sendEventMessages({
      token,
      chatId,
      topicId: generalTopicId,
      event,
      language,
      disableNotification: event.level === "info" && event.type !== "swap",
    });
  }
}

async function sendEventMessages(input: {
  token: string;
  chatId: string;
  topicId: number | null;
  event: AuditEvent;
  language: AppLanguage;
  disableNotification: boolean;
}) {
    const { token, chatId, topicId, event, language, disableNotification } = input;
    const category = translateText(event.level === "critical" ? "KRİTİK" : event.type === "swap" ? "İŞLEM" : event.level === "warning" ? "UYARI" : "BİLGİ", language);
    const chain = event.chainId ? `\n${language === "en" ? (event.chainId === "hyperliquid" ? "Platform" : "Network") : (event.chainId === "hyperliquid" ? "Platform" : "Ağ")}: ${CHAIN_DEFINITIONS[event.chainId].name}` : "";
    const heading = `<b>[${category}] ${escapeHtml(translateText(event.title, language))}</b>${chain}`;
    const messages = splitTelegramMessage(heading, translateText(event.message, language));
    const explorerUrl = event.txHash && event.chainId && event.chainId !== "hyperliquid"
      ? `${CHAIN_DEFINITIONS[event.chainId].explorerUrl}/tx/${event.txHash}`
      : null;
    for (const [index, text] of messages.entries()) {
      await sendTelegramMessage({
        token,
        chatId,
        topicId,
        text,
        disableNotification,
        buttons: explorerUrl && index === messages.length - 1
          ? [{ text: language === "en" ? "Open in explorer" : "Explorer'da aç", url: explorerUrl }]
          : [],
      });
    }
}

function findExecutionAttempt(event: AuditEvent) {
  const normalizedReference = event.txHash?.toLowerCase() ?? null;
  if (!normalizedReference) return null;
  return store.listExecutionAttempts(500).find((attempt) => {
    if (!["confirmed", "simulated"].includes(attempt.status)) return false;
    const references = [
      attempt.txHash,
      attempt.externalOrderId,
      stringMetadata(attempt, "sourceReference"),
    ].filter(Boolean).map((value) => value!.toLowerCase());
    return references.includes(normalizedReference);
  }) ?? null;
}

function formatTradeNotification(attempt: ExecutionAttempt, event: AuditEvent, language: AppLanguage) {
  const isBuy = ["buy", "open", "increase", "spot_buy"].includes(attempt.action.toLowerCase());
  const metadata = attempt.metadata;
  const priceUsd = positiveNumber(metadata.averageFillPriceUsd) ?? positiveNumber(attempt.quotedPriceUsd) ?? positiveNumber(metadata.marketPriceUsd);
  const marketCapUsd = positiveNumber(metadata.marketCapUsd);
  const quantity = positiveNumber(metadata.tokenQuantity);
  const tradeValueUsd = positiveNumber(metadata.tradeValueUsd) ?? 0;
  const totalFeeUsd = Math.max(0, attempt.networkFeeUsd) + Math.max(0, attempt.dexFeeUsd);
  const realizedPnlUsd = numberMetadata(metadata, "realizedPnlUsd");
  const realizedPnlPercent = numberMetadata(metadata, "realizedPnlPercent");
  const walletLabel = stringMetadata(attempt, "walletLabel")
    ?? (attempt.walletId ? store.getWallet(attempt.walletId)?.label : null)
    ?? (language === "en" ? "Manual trade" : "Manuel işlem");
  const side = language === "en"
    ? isBuy ? "BUY" : "SELL"
    : isBuy ? "ALIM" : "SATIM";
  const lines = [
    `<b>[${side}] ${escapeHtml(attempt.asset)}</b>`,
    `${language === "en" ? "Network" : "Ağ"}: ${escapeHtml(CHAIN_DEFINITIONS[attempt.integrationId].name)}`,
    `${language === "en" ? "Price" : "Fiyat"}: ${formatUsd(priceUsd, language, 10)}`,
    `${language === "en" ? "Market cap" : "Piyasa değeri"}: ${formatUsd(marketCapUsd, language, 2)}`,
    `${language === "en" ? "Quantity" : "Miktar"}: ${formatNumber(quantity, language, 8)}`,
    `${language === "en" ? (isBuy ? "Amount paid" : "Gross value") : (isBuy ? "Ödenen" : "Brüt değer")}: ${formatUsd(tradeValueUsd, language, 2)}`,
    `${language === "en" ? "Fees" : "Ücretler"}: ${formatUsd(totalFeeUsd, language, 4)}`,
    `${language === "en" ? "Source wallet" : "Kaynak cüzdan"}: ${escapeHtml(walletLabel)}`,
    `${language === "en" ? "Time" : "Zaman"}: ${formatDate(event.createdAt, language)}`,
  ];
  if (!isBuy) {
    lines.splice(7, 0,
      `${language === "en" ? "Net proceeds" : "Net satış geliri"}: ${formatUsd(positiveNumber(metadata.netProceedsUsd), language, 2)}`,
      `${language === "en" ? "Realized PnL" : "Gerçekleşen PnL"}: ${formatSignedUsd(realizedPnlUsd, language)}${realizedPnlPercent === null ? "" : ` (${formatSignedPercent(realizedPnlPercent, language)})`}`,
    );
  }
  return lines.join("\n");
}

function tradeButtons(attempt: ExecutionAttempt, language: AppLanguage) {
  const pairAddress = stringMetadata(attempt, "pairAddress");
  const tokenAddress = stringMetadata(attempt, "tokenAddress");
  const marketReference = pairAddress || tokenAddress || attempt.asset;
  return [{
    text: attempt.integrationId === "hyperliquid"
      ? (language === "en" ? "Open market" : "Piyasayı aç")
      : "DexScreener",
    url: integrationMarketUrl(attempt.integrationId, marketReference),
  }];
}

async function sendTelegramMessage(input: {
  token: string;
  chatId: string;
  topicId: number | null;
  text: string;
  disableNotification: boolean;
  buttons: Array<{ text: string; url: string }>;
}) {
  const response = await monitorService("telegram", () => fetch(`https://api.telegram.org/bot${input.token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: input.chatId,
      ...(input.topicId ? { message_thread_id: input.topicId } : {}),
      text: input.text,
      parse_mode: "HTML",
      disable_notification: input.disableNotification,
      ...(input.buttons.length ? { reply_markup: { inline_keyboard: [input.buttons] } } : {}),
    }),
  }));
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { description?: string } | null;
    throw new Error(payload?.description ?? `Telegram API hatası (${response.status}).`);
  }
}

function topicId(name: string) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function stringMetadata(attempt: ExecutionAttempt, key: string) {
  const value = attempt.metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberMetadata(metadata: Record<string, unknown>, key: string) {
  const value = Number(metadata[key]);
  return Number.isFinite(value) ? value : null;
}

function positiveNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function formatUsd(value: number | null, language: AppLanguage, maximumFractionDigits: number) {
  if (value === null) return "—";
  return new Intl.NumberFormat(language === "en" ? "en-US" : "tr-TR", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value > 0 && value < 0.01 ? Math.min(6, maximumFractionDigits) : 2,
    maximumFractionDigits,
  }).format(value);
}

function formatSignedUsd(value: number | null, language: AppLanguage) {
  if (value === null) return "—";
  return `${value >= 0 ? "+" : "-"}${formatUsd(Math.abs(value), language, 4)}`;
}

function formatNumber(value: number | null, language: AppLanguage, maximumFractionDigits: number) {
  if (value === null) return "—";
  return new Intl.NumberFormat(language === "en" ? "en-US" : "tr-TR", { maximumFractionDigits }).format(value);
}

function formatSignedPercent(value: number, language: AppLanguage) {
  return `${value >= 0 ? "+" : ""}${new Intl.NumberFormat(language === "en" ? "en-US" : "tr-TR", { maximumFractionDigits: 2 }).format(value)}%`;
}

function formatDate(value: string, language: AppLanguage) {
  return new Intl.DateTimeFormat(language === "en" ? "en-GB" : "tr-TR", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "Europe/Istanbul",
  }).format(new Date(value));
}

let provider: NotificationProvider | null = null;
export const getNotificationProvider = () => (provider ??= new TelegramNotificationProvider());
