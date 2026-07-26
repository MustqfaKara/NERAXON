import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/security/same-origin";
import { reconcileSourcePositions } from "@/lib/services/source-position-reconciliation";
import { apiError } from "@/lib/utils/api";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    return NextResponse.json(await reconcileSourcePositions());
  } catch (error) {
    return apiError(error);
  }
}
