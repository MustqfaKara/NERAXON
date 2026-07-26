import { NextResponse } from "next/server";
import { getHypercoreMarkets } from "@/lib/services/hypercore-api";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ markets: await getHypercoreMarkets() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
