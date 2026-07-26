export function roundHypercoreSize(quantity: number, sizeDecimals: number) {
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("Emir miktarı sıfırdan büyük olmalı.");
  const factor = 10 ** sizeDecimals;
  return Math.floor(quantity * factor + 1e-9) / factor;
}

export function roundHypercoreOpenSize(input: {
  quantity: number;
  sizeDecimals: number;
  priceUsd: number;
  minimumNotionalUsd: number;
  maximumNotionalUsd: number;
  availableNotionalUsd: number;
}) {
  const roundedDown = roundHypercoreSize(input.quantity, input.sizeDecimals);
  if (roundedDown * input.priceUsd + 1e-9 >= input.minimumNotionalUsd) return roundedDown;
  const factor = 10 ** input.sizeDecimals;
  const roundedUp = Math.ceil(input.minimumNotionalUsd / input.priceUsd * factor - 1e-9) / factor;
  const notionalUsd = roundedUp * input.priceUsd;
  const allowedNotionalUsd = Math.min(input.maximumNotionalUsd, input.availableNotionalUsd);
  if (notionalUsd > allowedNotionalUsd + 0.01) {
    if (notionalUsd > input.availableNotionalUsd + 0.01) {
      throw new Error(`HyperCore kullanılabilir bakiye ${notionalUsd.toFixed(2)} USD tutarındaki minimum tick emrini karşılamıyor.`);
    }
    throw new Error(`HyperCore minimum tick emri ${notionalUsd.toFixed(2)} USD ile ${input.maximumNotionalUsd.toFixed(2)} USD işlem tavanını aşıyor.`);
  }
  return roundedUp;
}

export function minimumHypercoreTickNotionalUsd(priceUsd: number, sizeDecimals: number, minimumNotionalUsd: number) {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) throw new Error("HyperCore piyasa fiyatı geçersiz.");
  const factor = 10 ** sizeDecimals;
  const quantity = Math.ceil(minimumNotionalUsd / priceUsd * factor - 1e-9) / factor;
  return quantity * priceUsd;
}

export function roundHypercorePrice(price: number, sizeDecimals: number, marketType: "spot" | "perp", side: "buy" | "sell") {
  if (!Number.isFinite(price) || price <= 0) throw new Error("Emir fiyatı sıfırdan büyük olmalı.");
  const significant = Number(price.toPrecision(5));
  const maxDecimals = Math.max(0, (marketType === "spot" ? 8 : 6) - sizeDecimals);
  const factor = 10 ** maxDecimals;
  return side === "buy" ? Math.ceil(significant * factor) / factor : Math.floor(significant * factor) / factor;
}

export function formatHypercoreNumber(value: number, decimals: number) {
  return value.toFixed(decimals).replace(/\.?0+$/, "");
}

export function hypercoreRequiredCapitalUsd(notionalUsd: number, leverage: number, feeRate = 0) {
  if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) return 0;
  const safeLeverage = Number.isFinite(leverage) && leverage > 0 ? leverage : 1;
  return notionalUsd / safeLeverage + notionalUsd * Math.max(0, feeRate);
}
