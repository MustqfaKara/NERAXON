import assert from "node:assert/strict";
import test from "node:test";
import { auditEventId } from "../src/lib/engine/audit-event-identity.ts";

test("aynı zincir işlemi ve olay türü süreçler arasında aynı kimliği üretir", () => {
  const input = { chainId: "base", txHash: "0xABC", type: "swap", title: "Swap değerlendirmeye alındı" };
  assert.equal(auditEventId(input), auditEventId({ ...input, txHash: "0xabc" }));
});

test("işlem kimliği olmayan sistem olayları benzersiz kalır", () => {
  const input = { chainId: null, txHash: null, type: "system", title: "Heartbeat" };
  assert.notEqual(auditEventId(input), auditEventId(input));
});
