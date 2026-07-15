import type { Position, TradeSide } from "@/lib/domain/types";

export function getCopyPositionConflict(
  position: Position | null,
  walletId: string,
  walletLabel: string,
  side: TradeSide,
  options: { allowConsensusBuy?: boolean } = {},
): string | null {
  if (!position) return null;
  if (position.sourceWalletId === walletId) return null;
  if (side === "buy" && options.allowConsensusBuy && position.sourceWalletId) return null;

  const owner = position.sourceWalletLabel ?? "başka bir kaynak cüzdan";
  if (side === "buy") {
    return `${position.tokenSymbol} pozisyonu ${owner} nedeniyle açık. ${walletLabel} alımı tekrar kopyalanmadı.`;
  }
  return `${position.tokenSymbol} pozisyonu ${owner} nedeniyle açıldı. ${walletLabel} satışı uygulanmadı; kaynak cüzdanın satışı beklenecek.`;
}
