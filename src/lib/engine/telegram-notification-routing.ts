import type { AuditEvent } from "@/lib/domain/types";

const COMPLETED_TRADE_TITLES = [
  /copy trade tamamlandı/i,
  /\b(?:live|shadow) HyperCore copy trade\b/i,
  /Canlı manuel swap tamamlandı/i,
  /Canlı Solana swap tamamlandı/i,
  /Canlı HyperCore emri tamamlandı/i,
  /paper (?:alımı|satışı)/i,
  /manuel paper (?:girişi|çıkışı)/i,
];

const IMPORTANT_WARNING_PATTERN =
  /devre kesici|acil durdur|işlem(?:ler)? durduruldu|canlı mutabakat|belirsiz canlı emir|özel anahtar|private key|hesap mutabakatı başarısız/i;

export function isCompletedTradeNotification(event: AuditEvent) {
  return event.type === "swap"
    && event.level === "info"
    && COMPLETED_TRADE_TITLES.some((pattern) => pattern.test(event.title));
}

export function isImportantNotification(event: AuditEvent) {
  if (event.level === "critical") return true;
  return event.level === "warning"
    && event.type === "system"
    && IMPORTANT_WARNING_PATTERN.test(`${event.title} ${event.message}`);
}
