import { store } from "@/lib/repositories/store";
import { publishEvent } from "@/lib/services/audit-service";

export async function enforceWalletActivityLimits() {
  const pausedWallets = store.pauseOveractiveWallets();
  await Promise.all(pausedWallets.map((wallet) => publishEvent({
    chainId: null,
    level: "warning",
    type: "system",
    title: "Yoğun işlem yapan cüzdan duraklatıldı",
    message: `${wallet.label} otomatik olarak izleme dışına alındı. ${wallet.reason} Yeni copy trade alınmayacak; açık pozisyonlar korunuyor.`,
    txHash: null,
  })));
  return pausedWallets;
}
