import type { AuditEvent } from "@/lib/domain/types";
import { store } from "@/lib/repositories/store";
import { deliverNotification } from "@/lib/services/notification-outbox";
import { auditEventId } from "@/lib/engine/audit-event-identity";

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
    id: auditEventId(input),
    createdAt: new Date().toISOString(),
  };
  if (!store.insertEvent(event)) return null;
  store.enqueueNotification(event.id);
  const deliveryError = await deliverNotification(event.id);
  if (deliveryError) {
    store.insertEvent({
      id: crypto.randomUUID(),
      chainId: event.chainId,
      level: "warning",
      type: "system",
      title: "Telegram bildirimi gönderilemedi",
      message: `${deliveryError} Bildirim outbox kuyruğunda yeniden denenecek.`,
      txHash: null,
      createdAt: new Date().toISOString(),
    });
  }
  return event;
}
