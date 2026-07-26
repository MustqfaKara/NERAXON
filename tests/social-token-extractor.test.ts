import assert from "node:assert/strict";
import test from "node:test";
import { extractSocialTokenReferences } from "../src/lib/engine/social-token-extractor.ts";

test("ülke veya kullanıcı metni yerine EVM kontratını ve ağ ipucunu çıkarır", () => {
  const result = extractSocialTokenReferences(
    "Base için CA: 0x1111111111111111111111111111111111111111",
  );
  assert.deepEqual(result[0], {
    chainHint: "base",
    value: "0x1111111111111111111111111111111111111111",
    referenceType: "address",
  });
});

test("pump.fun bağlantısından Solana mint adresini çıkarır", () => {
  const mint = "4NoNVDB4iAJDkdmP3QQckFvf3zbGuxjtoERHoYPfpump";
  const result = extractSocialTokenReferences(`https://pump.fun/coin/${mint}`);
  assert.equal(result.some((item) => item.referenceType === "pumpfun" && item.value === mint), true);
});

test("DexScreener bağlantısını pair referansı olarak sınıflandırır", () => {
  const result = extractSocialTokenReferences(
    "https://dexscreener.com/solana/7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
  );
  assert.equal(result[0].referenceType, "dexscreener_pair");
  assert.equal(result[0].chainHint, "solana");
  assert.equal(result[0].dexScreenerChainHint, "solana");
});

test("desteklenmeyen DexScreener ağını piyasa çözümleme ipucuyla korur", () => {
  const result = extractSocialTokenReferences(
    "https://dexscreener.com/stable/0x2f58e9ca6d919f2369c43f3a5d10959513218b9c",
  );
  assert.deepEqual(result[0], {
    chainHint: null,
    dexScreenerChainHint: "stable",
    value: "0x2f58e9ca6d919f2369c43f3a5d10959513218b9c",
    pairAddress: "0x2f58e9ca6d919f2369c43f3a5d10959513218b9c",
    referenceType: "dexscreener_pair",
  });
});

test("ticker adres yokken yalnızca çözümlenmemiş sinyal olarak çıkarılır", () => {
  const result = extractSocialTokenReferences("Bence $TOKEN izlenebilir");
  assert.deepEqual(result[0], {
    chainHint: null,
    value: "TOKEN",
    referenceType: "ticker",
  });
});
