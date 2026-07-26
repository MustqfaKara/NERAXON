import type { AuditEvent } from "@/lib/domain/types";
import { translateText } from "@/lib/i18n";
import { store } from "@/lib/repositories/store";
import { monitorService } from "@/lib/services/service-health";
import { CHAIN_DEFINITIONS } from "@/lib/domain/defaults";
import { escapeHtml, splitTelegramMessage } from "@/lib/engine/telegram-message";
import { readCredentialSync } from "@/lib/security/credential-vault";

export interface NotificationProvider {
  send(event: AuditEvent): Promise<void>;
}

class TelegramNotificationProvider implements NotificationProvider {
  async send(event: AuditEvent) {
    const token = readCredentialSync("telegram-bot-token");
    const chatId = readCredentialSync("telegram-chat-id");
    if (!token || !chatId) return;

    const language = store.getLanguage();
    const category = translateText(event.level === "critical" ? "KRİTİK" : event.type === "swap" ? "İŞLEM" : event.level === "warning" ? "UYARI" : "BİLGİ", language);
    const chain = event.chainId ? `\n${language === "en" ? (event.chainId === "hyperliquid" ? "Platform" : "Network") : (event.chainId === "hyperliquid" ? "Platform" : "Ağ")}: ${CHAIN_DEFINITIONS[event.chainId].name}` : "";
    const heading = `<b>[${category}] ${escapeHtml(translateText(event.title, language))}</b>${chain}`;
    const messages = splitTelegramMessage(heading, translateText(event.message, language));
    const explorerUrl = event.txHash && event.chainId && event.chainId !== "hyperliquid"
      ? `${CHAIN_DEFINITIONS[event.chainId].explorerUrl}/tx/${event.txHash}`
      : null;
    for (const [index, text] of messages.entries()) {
      const response = await monitorService("telegram", () => fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          disable_notification: event.level === "info" && event.type !== "swap",
          ...(explorerUrl && index === messages.length - 1 ? { reply_markup: { inline_keyboard: [[{ text: language === "en" ? "Open in explorer" : "Explorer'da aç", url: explorerUrl }]] } } : {}),
        }),
      }));
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { description?: string } | null;
        throw new Error(payload?.description ?? (language === "en" ? `Telegram API error (${response.status}).` : `Telegram API hatası (${response.status}).`));
      }
    }
  }
}

let provider: NotificationProvider | null = null;
export const getNotificationProvider = () => (provider ??= new TelegramNotificationProvider());
