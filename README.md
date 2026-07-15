# Crypto Trading Bot

Crypto Trading Bot (CopyDesk), Ethereum ve Base ağlarındaki başarılı cüzdanları izleyen, uygun swap işlemlerini risk kurallarıyla paper ortamında kopyalayan ve bütün süreci yerel bir web panelinden yönetmeyi sağlayan modüler bir uygulamadır.

> V1 yalnızca paper trading yapar. Gerçek fon veya private key kullanmaz.

![CopyDesk genel bakış paneli](./docs/dashboard.png)

## Özellikler

- **Cüzdan takibi:** Eklenen EVM cüzdanlarını zincir üzerinde izler; takip duraklatılabilir veya tamamen kaldırılabilir.
- **Copy trading:** Takip edilen cüzdanların swap işlemlerini çözümler ve uygun işlemleri paper portföye uygular.
- **Akıllı cüzdan keşfi:** Son 24 saatin yükselen tokenlarını tarar, kârlı cüzdanları bulur ve skorlar.
- **Çoklu cüzdan sinyali:** Aynı token için 1, 3, 7 ve 15 farklı cüzdan sinyalinde kademeli alım uygular.
- **Cüzdan bazlı pozisyonlar:** Alım ve satış kararlarını işlemi başlatan kaynak cüzdanla ilişkilendirir.
- **Risk motoru:** Pozisyon büyüklüğü, likidite, slippage, fiyat etkisi, volatilite ve portföy yoğunluğu sınırlarını uygular.
- **Gerçekçi paper execution:** DEX ücreti, gas, slippage, fiyat etkisi ve token vergisini simüle eder.
- **Manuel işlemler:** Kontrat adresinden token bilgilerini getirir; açık pozisyonlardan yüzdesel satış yapılmasını sağlar.
- **Performans takibi:** Portföy, token, cüzdan ve ağ bazında PnL, maliyet ve kazanma oranlarını gösterir.
- **Replay:** Kayıtlı işlemleri farklı ücret ve slippage koşullarıyla yeniden değerlendirir.
- **Telegram bildirimleri:** Swap, kopyalama kararı, hata ve sistem olaylarını ayrıntılı biçimde bildirir.
- **Sistem sağlığı:** RPC, DexScreener, Telegram ve diğer servislerin gecikme ve hata durumlarını izler.
- **TR / ENG desteği:** Web paneli, audit kayıtları ve Telegram mesajları iki dili destekler.
- **Yerel veri saklama:** Ayarlar, işlemler ve portföy SQLite üzerinde yalnızca bilgisayarda tutulur.

## Teknolojiler

- Next.js 16, React 19 ve TypeScript
- viem ile EVM bağlantısı
- SQLite (`node:sqlite`)
- DexScreener, Alchemy/EVM RPC ve Etherscan API
- Telegram Bot API

## Kurulum

Gereksinimler: Node.js 22+ ve npm.

```bash
git clone https://github.com/MustqfaKara/Crypto-Trading-Bot.git
cd Crypto-Trading-Bot
npm install
cp .env.example .env.local
npm run dev
```

Panel: [http://127.0.0.1:3000](http://127.0.0.1:3000)

`.env.local` dosyasında Ethereum/Base RPC adreslerini, Telegram bilgilerini ve isteğe bağlı Etherscan anahtarını tanımlayın. Gerçek anahtarları repoya eklemeyin.

## Komutlar

```bash
npm run dev        # Yerel geliştirme sunucusu
npm run build      # Production derlemesi
npm run typecheck  # TypeScript kontrolü
npm run lint       # Kod kalitesi kontrolü
npm test           # Testler
```

## Mimari

Proje ağ adaptörleri, işlem/risk motorları, servisler, veri katmanı ve web arayüzü olarak ayrılmıştır. Yeni EVM ağları `ChainAdapter` üzerinden mevcut işlem ve risk mantığını değiştirmeden eklenebilir. Ayrıntılar için [ARCHITECTURE.md](./ARCHITECTURE.md) dosyasına bakın.

## Yol Haritası

- V1: Ethereum ve Base üzerinde paper copy trading
- V1.x: Yeni EVM ağları ve gelişmiş keşif/indexer desteği
- V2: MiniMax API ile karar destek katmanı
- Sistem doğrulandıktan sonra kontrollü live trading altyapısı

## Uyarı

Bu proje eğitim ve araştırma amaçlıdır; finansal tavsiye değildir. Live trading aşamasına geçmeden önce private key yönetimi, işlem imzalama, limitler ve acil durdurma akışı ayrıca denetlenmelidir.
