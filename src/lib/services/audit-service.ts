import type { AuditEvent } from "@/lib/domain/types";
import { getNotificationProvider } from "@/lib/notifications/telegram";
import { store } from "@/lib/repositories/store";

export async function publishEvent(input: Omit<AuditEvent, "id" | "createdAt">) {
  if (
    input.type === "unknown" &&
    input.txHash &&
    store.hasConfirmedTradeForTransaction(input.chainId, input.txHash)
  ) {
    return null;
  }
  const event: AuditEvent = {
    ...input,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  store.insertEvent(event);
  try {
    await getNotificationProvider().send(event);
  } catch (error) {
    store.insertEvent({
      id: crypto.randomUUID(),
      chainId: event.chainId,
      level: "warning",
      type: "system",
      title: "Telegram bildirimi gönderilemedi",
      message: error instanceof Error ? error.message : "Bilinmeyen Telegram hatası.",
      txHash: null,
      createdAt: new Date().toISOString(),
    });
  }
  return event;
}
