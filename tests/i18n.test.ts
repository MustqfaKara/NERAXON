import assert from "node:assert/strict";
import test from "node:test";
import { localeFor, translateText } from "../src/lib/i18n.ts";
import { extraEnglishPhrases } from "../src/lib/i18n-en-extra.ts";

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

test("Solana keşif etiketlerini bütünüyle İngilizceye çevirir", () => {
  assert.equal(translateText("2 aday", "en"), "2 candidates");
  assert.equal(translateText("793 token transferi", "en"), "793 token transfers");
  assert.equal(translateText("Örnek işlemi explorer'da aç", "en"), "Open sample transaction in explorer");
  assert.equal(
    translateText("Helius 7g doğrulama · 4 token · 2 kapanış · %50 kazanma", "en"),
    "Helius 7d validation · 4 token · 2 round trips · %50 win rate",
  );
});

test("Türkçe seçiminde kaynak metni korur", () => {
  assert.equal(translateText("Cüzdan Keşfi", "tr"), "Cüzdan Keşfi");
  assert.equal(localeFor("tr"), "tr-TR");
  assert.equal(localeFor("en"), "en-US");
});

test("tüm ağ işlem görünümünü İngilizceye çevirir", () => {
  assert.equal(translateText("Tümü", "en"), "All");
  assert.equal(translateText("150 işlem kaydı", "en"), "150 trade records");
  assert.equal(translateText("EVM ve Solana işlem geçmişi", "en"), "EVM and Solana trade history");
});

test("kısa çeviri anahtarları başka kelimeleri veya Türkçe ekleri bozmaz", () => {
  assert.equal(translateText("Alchemy ve Uniswap", "en"), "Alchemy and Uniswap");
  assert.equal(translateText("DEUS satışı atlandı", "en"), "DEUS sell skipped");
  assert.equal(
    translateText("Hyperliquid keşif · 76 cüzdanına ait açık shadow lotu bulunamadı.", "en"),
    "Hyperliquid discovery · 76 has no linked open shadow lot.",
  );
});

test("runtime hata ve bildirim kataloğunun tamamı İngilizceye çevrilir", () => {
  for (const [source, target] of extraEnglishPhrases) {
    assert.equal(translateText(source, "en"), target, source);
  }
});
