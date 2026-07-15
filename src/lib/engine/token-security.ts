import type { MarketSnapshot } from "@/lib/services/market-data-provider";

export interface TokenSafetyResult {
  approved: boolean;
  warnings: string[];
  reason: string;
  score: number;
  checks: Array<{ label: string; status: "passed" | "warning" | "failed"; detail: string }>;
}

export function evaluateTokenSafety(market: MarketSnapshot): TokenSafetyResult {
  const warnings: string[] = [];
  const checks: TokenSafetyResult["checks"] = [];
  if (market.priceUsd <= 0) return reject("Token için güvenilir USD fiyatı bulunamadı.");
  if (market.liquidityUsd <= 0) return reject("Token havuzunda doğrulanabilir likidite bulunamadı.");
  checks.push({ label: "Piyasa fiyatı", status: "passed", detail: "Likiditeli havuzdan doğrulandı." });
  checks.push({ label: "Likidite", status: market.liquidityUsd >= 50_000 ? "passed" : "warning", detail: `${market.liquidityUsd.toFixed(0)} USD havuz likiditesi.` });

  if (market.pairCreatedAt) {
    const ageMinutes = (Date.now() - market.pairCreatedAt) / 60_000;
    if (ageMinutes < 30) return reject("Havuz 30 dakikadan yeni; işlem güvenlik nedeniyle reddedildi.");
    if (ageMinutes < 24 * 60) warnings.push("Havuz 24 saatten daha yeni.");
    checks.push({ label: "Havuz yaşı", status: ageMinutes < 24 * 60 ? "warning" : "passed", detail: `${Math.max(1, Math.floor(ageMinutes / 60))} saatlik havuz.` });
  }
  if (market.fdvUsd && market.liquidityUsd / market.fdvUsd < 0.005) {
    warnings.push("Likidite/FDV oranı düşük.");
  }
  if (market.volume24hUsd === 0) warnings.push("Son 24 saat hacmi raporlanmıyor.");
  const buys24h = market.buys24h ?? 0;
  const sells24h = market.sells24h ?? 0;
  checks.push({ label: "İşlem akışı", status: buys24h > 0 && sells24h > 0 ? "passed" : "warning", detail: `24 saatte ${buys24h} alım, ${sells24h} satış.` });
  const sellRatio = buys24h ? sells24h / buys24h : 0;
  if (buys24h >= 20 && sellRatio < 0.03) warnings.push("Satış akışı alımlara göre olağandışı düşük; honeypot riski ayrıca doğrulanmalı.");
  checks.push({ label: "Satılabilirlik sinyali", status: buys24h >= 20 && sellRatio < 0.03 ? "warning" : "passed", detail: "DEX işlem akışından davranışsal kontrol." });
  const score = Math.max(0, 100 - warnings.length * 12 - checks.filter((check) => check.status === "warning").length * 5);

  return {
    approved: true,
    warnings,
    reason: warnings.length ? warnings.join(" ") : "Temel token ve havuz kontrolleri geçti.",
    score,
    checks,
  };
}

function reject(reason: string): TokenSafetyResult {
  return { approved: false, warnings: [], reason, score: 0, checks: [{ label: "Güvenlik kontrolü", status: "failed", detail: reason }] };
}
