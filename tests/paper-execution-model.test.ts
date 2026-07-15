import test from "node:test";
import assert from "node:assert/strict";
import { dexFeePercentFor, modelPaperExecution } from "../src/lib/engine/paper-execution-model.ts";

test("alım gecikmesi ve likidite etkisi gerçekleşme fiyatını yükseltir", () => {
  const result = modelPaperExecution({ side: "buy", quotedPriceUsd: 1, grossUsd: 10, liquidityUsd: 100_000, slippagePercent: 0.5, dexFeePercent: 0.3, tokenTaxPercent: 1, priceChange24hPercent: 20, executionDelayMs: 12_000, gasFeeUsd: 0.1 });
  assert.ok(result.fillPriceUsd > 1);
  assert.ok(result.fees.tokenTaxUsd > 0);
  assert.equal(result.fees.totalUsd, result.fees.dexFeeUsd + result.fees.gasFeeUsd + result.fees.slippageUsd + result.fees.priceImpactUsd + result.fees.tokenTaxUsd);
});

test("satışta olumsuz gerçekleşme fiyatı ve DEX ücreti uygulanır", () => {
  const result = modelPaperExecution({ side: "sell", quotedPriceUsd: 1, grossUsd: 10, liquidityUsd: 50_000, slippagePercent: 0.5, dexFeePercent: dexFeePercentFor("uniswap"), tokenTaxPercent: 0, priceChange24hPercent: 10, executionDelayMs: 12_000, gasFeeUsd: 0.1 });
  assert.ok(result.fillPriceUsd < 1);
  assert.equal(result.fees.dexFeeUsd, 0.03);
});
