import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/security/same-origin";
import { closeAllTradingPositions } from "@/lib/services/close-all-paper-positions";
import { apiError } from "@/lib/utils/api";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    return NextResponse.json(await closeAllTradingPositions());
  } catch (error) {
    return apiError(error);
  }
}
