import { NextResponse } from "next/server";
import { errorMessage } from "@/lib/utils/error-message";

export function apiError(error: unknown, status = 400) {
  return NextResponse.json({ error: errorMessage(error) }, { status });
}
