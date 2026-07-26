export function calculateNativeBuyAmount(balanceWei: bigint, allocationPercent: number, gasReserveWei = 1_000_000_000_000_000n) {
  if (allocationPercent <= 0 || allocationPercent > 100) throw new Error("Alım oranı 0-100 aralığında olmalı.");
  const spendable = balanceWei > gasReserveWei ? balanceWei - gasReserveWei : 0n;
  return spendable * BigInt(Math.round(allocationPercent * 100)) / 10_000n;
}

export function calculateTokenSellAmount(balance: bigint, sellPercent: number) {
  if (sellPercent <= 0 || sellPercent > 100) throw new Error("Satış oranı 0-100 aralığında olmalı.");
  return balance * BigInt(Math.round(sellPercent * 100)) / 10_000n;
}

export function quoteNativeValueUsd(side: "buy" | "sell", sellAmount: bigint, buyAmount: bigint, nativePriceUsd: number) {
  const nativeAmount = side === "buy" ? sellAmount : buyAmount;
  return Number(nativeAmount) / 1e18 * nativePriceUsd;
}
