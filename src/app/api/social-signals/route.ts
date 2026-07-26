import { NextResponse } from "next/server";
import { z } from "zod";
import { consolidateSocialSignals } from "@/lib/engine/social-ai-policy";
import { store } from "@/lib/repositories/store";
import { assertSameOrigin } from "@/lib/security/same-origin";
import {
  ensureTelegramUserSignalService,
  getTelegramSocialRuntimeStatus,
  listTelegramUserChats,
  refreshSocialSignalMarkets,
} from "@/lib/services/telegram-user-signal-service";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

const settingsSchema = z.object({
  enabled: z.boolean(),
  selectedChatIds: z.array(z.string().min(1).max(80)).max(20),
  dailyAiLimit: z.number().int().min(1).max(100),
});

export async function GET(request: Request) {
  try {
    const refreshChats = new URL(request.url).searchParams.get("refreshChats") === "true";
    const chats = await listTelegramUserChats(refreshChats);
    await Promise.all([
      ensureTelegramUserSignalService(),
      refreshSocialSignalMarkets(),
    ]);
    return NextResponse.json({
      settings: store.getTelegramSocialSettings(),
      status: getTelegramSocialRuntimeStatus(),
      chats,
      signals: consolidateSocialSignals(store.listSocialTokenSignals()),
      aiAdvisories: store.listAiTradeAdvisories(300)
        .filter((entry) => entry.sourceReference.startsWith("social:")),
      aiUsage: {
        social: store.getAiRequestUsageToday("social_signal"),
        total: store.getAiRequestUsageToday(),
        totalLimit: 100,
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error, 500);
  }
}

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const settings = settingsSchema.parse(await request.json());
    store.setTelegramSocialSettings(settings);
    await ensureTelegramUserSignalService();
    return NextResponse.json({
      settings: store.getTelegramSocialSettings(),
      status: getTelegramSocialRuntimeStatus(),
    });
  } catch (error) {
    return apiError(error);
  }
}
