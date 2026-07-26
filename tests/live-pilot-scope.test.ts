import assert from "node:assert/strict";
import test from "node:test";
import { LIVE_PILOT_INTEGRATION_IDS, isLivePilotIntegration } from "../src/lib/domain/integrations.ts";

test("canlı pilot Base, Robinhood, Solana ve Hyperliquid ağlarını içerir", () => {
  assert.deepEqual([...LIVE_PILOT_INTEGRATION_IDS], ["base", "robinhood", "solana", "hyperliquid"]);
  assert.equal(isLivePilotIntegration("base"), true);
  assert.equal(isLivePilotIntegration("robinhood"), true);
  assert.equal(isLivePilotIntegration("solana"), true);
  assert.equal(isLivePilotIntegration("hyperliquid"), true);
  assert.equal(isLivePilotIntegration("ethereum"), false);
});
