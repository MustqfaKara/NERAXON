# Mimari

EVM CopyDesk üç ana katmandan oluşur:

1. `src/lib/chains`: Ağ bağlantısı, blok izleme, transaction sınıflandırma ve receipt çözümleme.
2. `src/lib/engine`: Cüzdan skoru, token güvenliği, risk kararı ve paper execution.
3. `src/lib/services`: Orkestrasyon, piyasa verisi, Telegram, audit ve otomatik kopya akışı.

Web paneli yalnızca API route'larıyla konuşur. UI, doğrudan RPC veya SQLite erişimi yapmaz.

## Otomatik kopya akışı

```text
Yeni blok
  -> Takip edilen from adresi
  -> Calldata sınıflandırması
  -> Onaylanmış receipt içindeki Transfer logları
  -> Cüzdana giren/çıkan tokenın belirlenmesi
  -> DEX Screener fiyat ve likidite verisi
  -> Token güvenlik filtresi
  -> Cüzdan skoru ve risk motoru
  -> Paper execution
  -> SQLite + Telegram + web audit akışı
```

Likidite ekleme, likidite çıkarma, approval, transfer ve bilinmeyen kontrat çağrıları kopyalanmaz. Bunlar audit kaydına ve cüzdan skoruna yansıtılır.

## Cüzdan keşfi

```text
Alchemy aktif ERC-20 evreni
  -> DexScreener toplu piyasa verisi
  -> En çok yükselen 10 likit token
  -> DexScreener tüm pool adresleri
  -> Token odaklı sayfalı Alchemy transfer taraması
  -> Pool bağlantılı net alıcı/satıcı grafiği
  -> Güncel gas modeliyle net PnL
  -> Alım + satış + minimum işlem + ROI filtreleri
  -> Public RPC eth_getCode ile EOA doğrulaması
  -> Genel ve token bazlı cüzdan sıralaması
```

DexScreener cüzdan adresi sağlamaz; token, pool ve piyasa bağlamı için kullanılır. Cüzdan adresleri zincir üstü transfer grafiğinden çıkarılır. Etherscan keşfin ana veri yolunda kullanılmaz.

## Ağ ekleme

Yeni ağ için `ChainAdapter` uygulanır ve `registry.ts` içine kaydedilir. Risk motoru, paper motoru ve web bileşenleri zincire özel RPC mantığı içermez.

## V1 veri sınırı

Worker çalıştığı andan sonraki blokları izler. Geçmiş cüzdan performansının hızlı doldurulması için ileride ayrı bir indexer sağlayıcısı bağlanacaktır. Bu sınır cüzdan kartında `Gözlemde` durumu ile açıkça gösterilir.
