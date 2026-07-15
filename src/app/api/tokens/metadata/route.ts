import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveTokenQuote } from "@/lib/services/token-quote-service";
import { apiError } from "@/lib/utils/api";

const schema = z.object({
  chainId: z.enum(["ethereum", "base"]),
  address: z.string().trim(),
});

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const input = schema.parse({
      chainId: url.searchParams.get("chainId"),
      address: url.searchParams.get("address"),
    });
    const token = await resolveTokenQuote(input.chainId, input.address);
    return NextResponse.json({ token }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
