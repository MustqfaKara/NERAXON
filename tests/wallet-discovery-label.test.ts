import assert from "node:assert/strict";
import test from "node:test";
import { formatDiscoveryWalletLabel } from "../src/lib/utils/discovery-wallet-label.ts";

test("keşif cüzdanı etiketini İstanbul tarihi ve saatiyle üretir", () => {
  assert.equal(formatDiscoveryWalletLabel("2026-07-26T00:17:42.000Z"), "26.07.2026 03:17:42");
});
