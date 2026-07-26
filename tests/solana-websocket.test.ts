import test from "node:test";
import assert from "node:assert/strict";
import { parseSolanaLogsNotification } from "../src/lib/solana/websocket-notification.ts";

test("başarılı Solana log bildiriminden imza ve slot çıkarılır", () => {
  const result = parseSolanaLogsNotification({
    context: { slot: 123 },
    value: { signature: "signature-a", err: null },
  });

  assert.deepEqual(result, { signature: "signature-a", slot: 123 });
});

test("başarısız veya imzasız Solana log bildirimi işlenmez", () => {
  assert.equal(parseSolanaLogsNotification({ value: { signature: "signature-a", err: { code: 1 } } }), null);
  assert.equal(parseSolanaLogsNotification({ context: { slot: 123 }, value: {} }), null);
});
