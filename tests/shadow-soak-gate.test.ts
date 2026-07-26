import assert from "node:assert/strict";
import test from "node:test";
import { isSoakBlockingCriticalEvent } from "../src/lib/services/shadow-soak-gate.ts";

test("cüzdan davranış uyarısı shadow soak sonucunu düşürmez", () => {
  assert.equal(isSoakBlockingCriticalEvent({ level: "critical", type: "liquidity_remove", title: "Likidite kaldırıldı", message: "Kaynak cüzdan davranışı." }), false);
});

test("kritik sistem hatası shadow soak sonucunu düşürür", () => {
  assert.equal(isSoakBlockingCriticalEvent({ level: "critical", type: "system", title: "Mutabakat hatası", message: "İşlem muhasebeleştirilemedi." }), true);
});

test("kritik test bildirimi shadow soak sonucunu etkilemez", () => {
  assert.equal(isSoakBlockingCriticalEvent({ level: "critical", type: "system", title: "Test bildirimi", message: "Kanal doğrulaması." }), false);
});
