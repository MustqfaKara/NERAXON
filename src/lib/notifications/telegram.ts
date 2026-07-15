import type { AuditEvent } from "@/lib/domain/types";
import { translateText } from "@/lib/i18n";
import { store } from "@/lib/repositories/store";
import { monitorService } from "@/lib/services/service-health";

export interface NotificationProvider {
  send(event: AuditEvent): Promise<void>;
}

class TelegramNotificationProvider implements NotificationProvider {
  async send(event: AuditEvent) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;

    const language = store.getLanguage();
    const category = translateText(event.level === "critical" ? "KRİTİK" : event.type === "swap" ? "İŞLEM" : event.level === "warning" ? "UYARI" : "BİLGİ", language);
    const chain = event.chainId ? `\n${language === "en" ? "Network" : "Ağ"}: ${event.chainId === "base" ? "Base" : "Ethereum"}` : "";
    const text = `<b>[${category}] ${escapeHtml(translateText(event.title, language))}</b>${chain}\n${escapeHtml(translateText(event.message, language))}`;
    const explorerUrl = event.txHash && event.chainId
      ? `${event.chainId === "base" ? "https://basescan.org" : "https://etherscan.io"}/tx/${event.txHash}`
      : null;
    const response = await monitorService("telegram", () => fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_notification: event.level === "info" && event.type !== "swap",
        ...(explorerUrl ? { reply_markup: { inline_keyboard: [[{ text: language === "en" ? "Open in explorer" : "Explorer'da aç", url: explorerUrl }]] } } : {}),
      }),
    }));
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { description?: string } | null;
      throw new Error(payload?.description ?? (language === "en" ? `Telegram API error (${response.status}).` : `Telegram API hatası (${response.status}).`));
    }
  }
}

const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

let provider: NotificationProvider | null = null;
export const getNotificationProvider = () => (provider ??= new TelegramNotificationProvider());
