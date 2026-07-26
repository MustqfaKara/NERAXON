import type { AuditEvent } from "../domain/types.ts";

export function isSoakBlockingCriticalEvent(event: Pick<AuditEvent, "level" | "type" | "title" | "message">) {
  if (event.level !== "critical" || event.type !== "system") return false;
  return !/test bildirimi|deneme bildirimi/i.test(`${event.title} ${event.message}`);
}
