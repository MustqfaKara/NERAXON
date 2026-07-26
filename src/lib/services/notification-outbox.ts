import { notificationRetryDelayMs, shouldDeadLetterNotification } from "@/lib/engine/notification-retry";
import { getNotificationProvider } from "@/lib/notifications/telegram";
import { store } from "@/lib/repositories/store";

let pendingFlush: Promise<void> | null = null;

export async function deliverNotification(eventId: string): Promise<string | null> {
  const delivery = store.getNotificationDelivery(eventId);
  if (!delivery || delivery.status === "sent") return null;
  if (delivery.status === "dead") return delivery.last_error;
  if (shouldDeadLetterNotification(delivery.last_error ?? "", delivery.attempts)) {
    const message = delivery.last_error ?? "Telegram bildirim deneme sınırı aşıldı.";
    store.markNotificationDead(eventId, message);
    return message;
  }
  const event = store.getEvent(eventId);
  if (!event) return "Bildirim olayı bulunamadı.";
  try {
    await getNotificationProvider().send(event);
    store.markNotificationSent(eventId);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Bilinmeyen Telegram hatası.";
    if (shouldDeadLetterNotification(message, delivery.attempts + 1)) {
      store.markNotificationDead(eventId, message);
      return message;
    }
    const nextAttemptAt = new Date(Date.now() + notificationRetryDelayMs(delivery.attempts + 1)).toISOString();
    store.markNotificationRetry(eventId, message, nextAttemptAt);
    return message;
  }
}

export async function flushNotificationOutbox() {
  if (pendingFlush) return pendingFlush;
  pendingFlush = (async () => {
    for (const eventId of store.listDueNotificationEventIds()) await deliverNotification(eventId);
  })();
  try {
    await pendingFlush;
  } finally {
    pendingFlush = null;
  }
}
