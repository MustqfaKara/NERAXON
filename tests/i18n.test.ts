import assert from "node:assert/strict";
import test from "node:test";
import { localeFor, translateText } from "../src/lib/i18n.ts";

test("İngilizce çeviri hedef metni ikinci kez dönüştürmez", () => {
  const result = translateText("3 farklı cüzdan ve 8 swap", "en");
  assert.equal(result, "3 distinct wallets and 8 swaps");
});

test("sınıflandırma bildirimini ve sayı biçimini birlikte çevirir", () => {
  const result = translateText(
    "Blok: 25.537.189 Gas maliyeti: 0,00002143 ETH Bot kararı: İşlem kopyalanmadı; açık pozisyonlar değiştirilmedi.",
    "en",
  );
  assert.equal(result, "Block: 25,537,189 Gas cost: 0.00002143 ETH Bot decision: The trade was not copied; open positions were unchanged.");
});

test("yalnızca sayı içeren İngilizce arayüz değerini değiştirmez", () => {
  assert.equal(translateText("$7.413", "en"), "$7.413");
});

test("Türkçe seçiminde kaynak metni korur", () => {
  assert.equal(translateText("Cüzdan Keşfi", "tr"), "Cüzdan Keşfi");
  assert.equal(localeFor("tr"), "tr-TR");
  assert.equal(localeFor("en"), "en-US");
});
