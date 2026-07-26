import assert from "node:assert/strict";
import test from "node:test";
import { resolveLivePositionLimit } from "../src/lib/engine/live-position-capacity.ts";

test("canlı pozisyon limiti portföy kapasitesi varsa kontrollü esner", () => {
  assert.equal(resolveLivePositionLimit({
    equityUsd: 10,
    estimatedTradeUsd: 1.25,
    configuredLimit: 4,
    globalLimit: 12,
    cashReservePercent: 15,
    minPositionPercent: 8,
    minTradeUsd: 0,
  }), 6);
});

test("minimum emir büyüklüğü yüksek ağda yapılandırılmış güvenlik tabanı korunur", () => {
  assert.equal(resolveLivePositionLimit({
    equityUsd: 20,
    estimatedTradeUsd: 10.5,
    configuredLimit: 2,
    globalLimit: 12,
    cashReservePercent: 15,
    minPositionPercent: 8,
    minTradeUsd: 10.5,
  }), 2);
});

test("dinamik limit global pozisyon tavanını aşmaz", () => {
  assert.equal(resolveLivePositionLimit({
    equityUsd: 1_000,
    estimatedTradeUsd: 1,
    configuredLimit: 4,
    globalLimit: 12,
    cashReservePercent: 15,
    minPositionPercent: 0,
    minTradeUsd: 0,
  }), 12);
});
