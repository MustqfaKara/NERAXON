import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/security/same-origin";
import {
  confirmTelegramLoginCode,
  confirmTelegramLoginPassword,
  requestTelegramLoginCode,
} from "@/lib/security/telegram-web-auth";
import { apiError } from "@/lib/utils/api";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("request-code"), phoneNumber: z.string().min(8).max(24) }),
  z.object({ action: z.literal("confirm-code"), loginId: z.string().uuid(), code: z.string().min(4).max(12) }),
  z.object({ action: z.literal("confirm-password"), loginId: z.string().uuid(), password: z.string().min(1).max(512) }),
]);

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = schema.parse(await request.json());
    const result = input.action === "request-code"
      ? await requestTelegramLoginCode(input.phoneNumber)
      : input.action === "confirm-code"
        ? await confirmTelegramLoginCode(input.loginId, input.code)
        : await confirmTelegramLoginPassword(input.loginId, input.password);
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
