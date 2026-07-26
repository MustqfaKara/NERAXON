import test from "node:test";
import assert from "node:assert/strict";
import { geckoTerminalNetworkForChain } from "../src/lib/services/geckoterminal-networks.ts";

test("Ethereum keşfi GeckoTerminal eth ağını kullanır", () => {
  assert.equal(geckoTerminalNetworkForChain("ethereum"), "eth");
});

test("Base ve Robinhood keşfi kendi GeckoTerminal ağ kimliklerini korur", () => {
  assert.equal(geckoTerminalNetworkForChain("base"), "base");
  assert.equal(geckoTerminalNetworkForChain("robinhood"), "robinhood");
});
