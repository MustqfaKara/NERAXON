import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({
    status: "ok",
    service: "neraxon",
    timestamp: new Date().toISOString(),
  }, { headers: { "cache-control": "no-store" } });
}
