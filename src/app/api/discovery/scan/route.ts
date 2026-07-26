import { NextResponse } from "next/server";
import { z } from "zod";
import { getWalletDiscoveryProvider } from "@/lib/services/wallet-discovery-provider";
import { apiError } from "@/lib/utils/api";
import { assertSameOrigin } from "@/lib/security/same-origin";

const schema = z.object({ chainId: z.enum(["ethereum", "base", "robinhood", "solana", "hyperliquid"]) });

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = schema.parse(await request.json());
    const scan = await getWalletDiscoveryProvider().scan(input.chainId, { forceRefresh: true });
    return NextResponse.json({ scan }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
