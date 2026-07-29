import { NextResponse } from "next/server";
import { z } from "zod";
import { store } from "@/lib/repositories/store";
import { publishEvent } from "@/lib/services/audit-service";
import { apiError } from "@/lib/utils/api";
import { assertSameOrigin } from "@/lib/security/same-origin";
import { integrationName } from "@/lib/domain/integrations";
import { effectiveWalletChainIds } from "@/lib/engine/wallet-network-scope";

const schema = z.object({
  paused: z.boolean().optional(),
  isFavorite: z.boolean().optional(),
}).refine((input) => Number(input.paused !== undefined) + Number(input.isFavorite !== undefined) === 1, {
  message: "Tek seferde yalnızca bir cüzdan özelliği güncellenebilir.",
});

export async function PATCH(request: Request, context: { params: Promise<{ walletId: string }> }) {
  try {
    assertSameOrigin(request);
    const { walletId } = await context.params;
    const input = schema.parse(await request.json());
    if (input.isFavorite !== undefined) {
      const wallet = store.setWalletFavorite(walletId, input.isFavorite);
      const networkNames = effectiveWalletChainIds(wallet).map(integrationName).join(", ");
      await publishEvent({
        chainId: null,
        level: "info",
        type: "system",
        title: input.isFavorite ? "Cüzdan global takibe alındı" : "Cüzdan global takipten çıkarıldı",
        message: input.isFavorite
          ? `${wallet.label} artık ${networkNames} ağlarında aktif olarak izlenecek ve uygun işlemleri copy trade akışına alınacak.`
          : `${wallet.label} için yıldız kaldırıldı; takip yeniden seçili ağlarla sınırlandırıldı.`,
        txHash: null,
      });
      return NextResponse.json({ wallet });
    }
    const paused = input.paused as boolean;
    const wallet = store.setWalletPaused(walletId, paused);
    const networkNames = wallet.trackedChainIds.map(integrationName).join(", ");
    await publishEvent({
      chainId: null,
      level: "info",
      type: "system",
      title: paused ? "Cüzdan takibi duraklatıldı" : "Cüzdan takibi yeniden başlatıldı",
      message: `${wallet.label} (${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}) ${paused ? "yeni işlemler için izleme dışı bırakıldı" : `${networkNames} izleme setine alındı; yoğunluk sayacı yeniden başlatıldı`}.`,
      txHash: null,
    });
    return NextResponse.json({ wallet });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ walletId: string }> }) {
  try {
    assertSameOrigin(request);
    const { walletId } = await context.params;
    const wallet = store.deleteWallet(walletId);
    await publishEvent({
      chainId: null,
      level: "warning",
      type: "system",
      title: "Cüzdan takip listesinden çıkarıldı",
      message: `${wallet.label} artık yeni bloklarda izlenmeyecek. Geçmiş işlem ve audit kayıtları korundu.`,
      txHash: null,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error);
  }
}
