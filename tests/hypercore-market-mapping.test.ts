import assert from "node:assert/strict";
import test from "node:test";
import { mapSpotUniverseContexts } from "../src/lib/engine/hypercore-market-mapping.ts";

test("HyperCore spot contextlerini dizi sırası yerine coin anahtarıyla eşler", () => {
  const mapped = mapSpotUniverseContexts(
    [
      { name: "@107", index: 107, tokens: [150, 0] },
      { name: "@109", index: 109, tokens: [98, 0] },
    ],
    [
      { index: 0, name: "USDC", szDecimals: 8 },
      { index: 98, name: "WOW", szDecimals: 0 },
      { index: 150, name: "HYPE", szDecimals: 2 },
    ],
    [
      { coin: "@109", markPx: "1.25" },
      { coin: "@107", markPx: "59.58" },
    ],
  );

  assert.equal(mapped[0].baseToken?.name, "HYPE");
  assert.equal(mapped[0].context?.coin, "@107");
  assert.equal(mapped[0].context?.markPx, "59.58");
  assert.equal(mapped[1].baseToken?.name, "WOW");
  assert.equal(mapped[1].context?.coin, "@109");
});
