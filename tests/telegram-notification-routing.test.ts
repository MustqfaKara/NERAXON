import assert from "node:assert/strict";
import test from "node:test";
import type { AuditEvent } from "../src/lib/domain/types.ts";
import { isCompletedTradeNotification, isImportantNotification } from "../src/lib/engine/telegram-notification-routing.ts";

const event = (input: Partial<AuditEvent>): AuditEvent => ({
  id: "event",
  chainId: "base",
  level: "info",
  type: "swap",
  title: "TOKEN live copy trade tamamlandı",
  message: "Onaylandı.",
  txHash: "0x1",
  createdAt: new Date().toISOString(),
  ...input,
});

test("yalnızca tamamlanan işlem bildirimi alım-satım topicine yönlendirilir", () => {
  assert.equal(isCompletedTradeNotification(event({})), true);
  assert.equal(isCompletedTradeNotification(event({ title: "Swap değerlendirmeye alındı" })), false);
  assert.equal(isCompletedTradeNotification(event({ level: "warning", title: "TOKEN kopyası tamamlanamadı" })), false);
});

test("kritik olaylar Important topicine yönlendirilir", () => {
  assert.equal(isImportantNotification(event({ level: "critical", type: "system", title: "Canlı işlem durdu" })), true);
});

test("sıradan RPC uyarısı Important topicini doldurmaz", () => {
  assert.equal(isImportantNotification(event({ level: "warning", type: "system", title: "Base RPC izleme hatası" })), false);
  assert.equal(isImportantNotification(event({ level: "warning", type: "system", title: "Devre kesici etkinleşti" })), true);
});
