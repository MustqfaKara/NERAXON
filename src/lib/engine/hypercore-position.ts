import type { HypercorePositionSide } from "../domain/types.ts";

export function calculateHypercorePnl(side: HypercorePositionSide, entryPrice: number, currentPrice: number, quantity: number) {
  return side === "long" ? (currentPrice - entryPrice) * quantity : (entryPrice - currentPrice) * quantity;
}
