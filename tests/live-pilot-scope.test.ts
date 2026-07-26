import assert from "node:assert/strict";
import test from "node:test";
import { LIVE_PILOT_INTEGRATION_IDS, isLivePilotIntegration } from "../src/lib/domain/integrations.ts";

test("canlı pilot tüm desteklenen ağları içerir", () => {
  assert.deepEqual([...LIVE_PILOT_INTEGRATION_IDS], ["ethereum", "base", "robinhood", "solana", "hyperliquid"]);
  assert.equal(isLivePilotIntegration("ethereum"), true);
  assert.equal(isLivePilotIntegration("base"), true);
  assert.equal(isLivePilotIntegration("robinhood"), true);
  assert.equal(isLivePilotIntegration("solana"), true);
  assert.equal(isLivePilotIntegration("hyperliquid"), true);
});
