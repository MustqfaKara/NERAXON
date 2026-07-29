import assert from "node:assert/strict";
import test from "node:test";
import { parseInfoCommand, suggestInfoCommand } from "../src/lib/telegram/info-command-parser.ts";

test("EVM ve Solana alım komutlarını ayrıştırır", () => {
  assert.deepEqual(parseInfoCommand("/buy base 0x123 4,5"), {
    kind: "buy", chainId: "base", asset: "0x123", amountUsd: 4.5,
  });
  assert.deepEqual(parseInfoCommand("/buy sol MintAddress 3"), {
    kind: "buy", chainId: "solana", asset: "MintAddress", amountUsd: 3,
  });
});

test("HyperCore spot ve perp komutlarını ayrıştırır", () => {
  assert.deepEqual(parseInfoCommand("/buy hl spot HYPE 12"), {
    kind: "hyperBuy", marketType: "spot", coin: "HYPE", side: "long", amountUsd: 12, leverage: 1,
  });
  assert.deepEqual(parseInfoCommand("/buy hyper perp xyz:SP500 short 15 2"), {
    kind: "hyperBuy", marketType: "perp", coin: "xyz:SP500", side: "short", amountUsd: 15, leverage: 2,
  });
});

test("satış yüzdesini ve tümünü sat komutunu sınırlar", () => {
  assert.equal(parseInfoCommand("/sell base 0x123 101"), null);
  assert.deepEqual(parseInfoCommand("/sell hl perp HYPE long 50"), {
    kind: "hyperSell", marketType: "perp", coin: "HYPE", side: "long", percent: 50,
  });
  assert.deepEqual(parseInfoCommand("/sellall sol"), { kind: "sellAll", chainId: "solana" });
});

test("tanınmayan veya eksik komutları reddeder", () => {
  assert.equal(parseInfoCommand("balance"), null);
  assert.equal(parseInfoCommand("/buy base"), null);
  assert.equal(parseInfoCommand("/buy bilinmeyen token 5"), null);
});

test("yakın yazım hatalarında doğru komutu önerir", () => {
  assert.equal(suggestInfoCommand("/bala"), "/balance");
  assert.equal(suggestInfoCommand("/positons"), "/positions");
  assert.equal(suggestInfoCommand("/tamamen-farkli"), null);
  assert.equal(suggestInfoCommand("/balance"), null);
});
