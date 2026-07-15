import { NextResponse } from "next/server";
import { z } from "zod";
import { store } from "@/lib/repositories/store";
import { publishEvent } from "@/lib/services/audit-service";
import { apiError } from "@/lib/utils/api";

const schema = z.object({ paused: z.boolean() });

export async function PATCH(request: Request, context: { params: Promise<{ walletId: string }> }) {
  try {
    const { walletId } = await context.params;
    const { paused } = schema.parse(await request.json());
    const wallet = store.setWalletPaused(walletId, paused);
    await publishEvent({
      chainId: null,
      level: "info",
      type: "system",
      title: paused ? "Cüzdan takibi duraklatıldı" : "Cüzdan takibi yeniden başlatıldı",
      message: `${wallet.label} (${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}) ${paused ? "yeni bloklarda izleme dışı bırakıldı" : "Base ve Ethereum izleme setine alındı"}.`,
      txHash: null,
    });
    return NextResponse.json({ wallet });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ walletId: string }> }) {
  try {
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
