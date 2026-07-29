import assert from "node:assert/strict";
import test from "node:test";
import { isEvmCursorStalled } from "../src/lib/chains/cursor-stall.ts";

const now = Date.parse("2026-07-28T00:00:00.000Z");

test("ilerlemeyen ve geride kalan Base cursorunu durmuş sayar", () => {
  assert.equal(isEvmCursorStalled({
    chainId: "base",
    lastBlock: 2_000,
    cursor: 1_000,
    cursorUpdatedAt: "2026-07-27T23:55:00.000Z",
    now,
  }), true);
});

test("güncel olarak ilerleyen replay cursorunu yeniden başlatmaz", () => {
  assert.equal(isEvmCursorStalled({
    chainId: "base",
    lastBlock: 2_000,
    cursor: 1_000,
    cursorUpdatedAt: "2026-07-27T23:59:30.000Z",
    now,
  }), false);
});

test("eski olsa bile zincire yakın cursoru durmuş saymaz", () => {
  assert.equal(isEvmCursorStalled({
    chainId: "ethereum",
    lastBlock: 2_000,
    cursor: 1_995,
    cursorUpdatedAt: "2026-07-27T23:50:00.000Z",
    now,
  }), false);
});

test("yeniden başlayan izleyiciye replay için toparlanma süresi tanır", () => {
  const now = Date.parse("2026-07-27T22:00:00.000Z");
  assert.equal(isEvmCursorStalled({
    chainId: "ethereum",
    lastBlock: 25_627_000,
    cursor: 25_626_000,
    cursorUpdatedAt: "2026-07-27T19:00:00.000Z",
    watcherStartedAt: now - 60_000,
    now,
  }), false);
});

test("toparlanma süresi dolan ve ilerlemeyen izleyiciyi durmuş sayar", () => {
  const now = Date.parse("2026-07-27T22:00:00.000Z");
  assert.equal(isEvmCursorStalled({
    chainId: "ethereum",
    lastBlock: 25_627_000,
    cursor: 25_626_000,
    cursorUpdatedAt: "2026-07-27T19:00:00.000Z",
    watcherStartedAt: now - 4 * 60_000,
    now,
  }), true);
});
