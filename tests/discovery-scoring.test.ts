import test from "node:test";
import assert from "node:assert/strict";
import { calculateDiscoveryScore } from "../src/lib/engine/discovery-scoring.ts";

test("aktif ve çeşitli swap cüzdanını daha yüksek puanlar", () => {
  const active = calculateDiscoveryScore({ swapCount: 5, buyCount: 3, sellCount: 2, uniqueTokenCount: 4, ageMinutes: 10, estimatedPnlPercent: 18 });
  const passive = calculateDiscoveryScore({ swapCount: 1, buyCount: 1, sellCount: 0, uniqueTokenCount: 1, ageMinutes: 600, estimatedPnlPercent: -5 });
  assert.ok(active.score > passive.score);
});

test("keşif skoru yüz puanı aşmaz", () => {
  const result = calculateDiscoveryScore({ swapCount: 100, buyCount: 50, sellCount: 50, uniqueTokenCount: 100, ageMinutes: 0, estimatedPnlPercent: 100 });
  assert.equal(result.score, 100);
});
