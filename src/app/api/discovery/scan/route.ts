import { NextResponse } from "next/server";
import { z } from "zod";
import { getWalletDiscoveryProvider } from "@/lib/services/wallet-discovery-provider";
import { apiError } from "@/lib/utils/api";

const schema = z.object({ chainId: z.enum(["ethereum", "base"]) });

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const input = schema.parse(await request.json());
    const scan = await getWalletDiscoveryProvider().scan(input.chainId);
    return NextResponse.json({ scan }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
