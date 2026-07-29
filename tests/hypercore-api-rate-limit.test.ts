import assert from "node:assert/strict";
import test from "node:test";
import { hypercoreRetryDelayMs } from "../src/lib/engine/hypercore-rate-limit.ts";

test("HyperCore 429 Retry-After saniyesine uyar", () => {
  assert.equal(hypercoreRetryDelayMs("3", 0, 0), 3_000);
});

test("HyperCore 429 HTTP tarihini en fazla bir dakika bekler", () => {
  const now = Date.parse("2026-07-29T00:00:00.000Z");
  assert.equal(
    hypercoreRetryDelayMs("Wed, 29 Jul 2026 00:00:05 GMT", 0, now),
    5_000,
  );
  assert.equal(
    hypercoreRetryDelayMs("Wed, 29 Jul 2026 00:05:00 GMT", 0, now),
    60_000,
  );
});

test("Retry-After yoksa HyperCore bekleme süresi üstel ve sınırlıdır", () => {
  assert.equal(hypercoreRetryDelayMs(null, 0, 0), 1_000);
  assert.equal(hypercoreRetryDelayMs(null, 2, 0), 4_000);
  assert.equal(hypercoreRetryDelayMs(null, 10, 0), 8_000);
});
