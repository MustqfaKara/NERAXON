import { NextResponse } from "next/server";
import { z } from "zod";
import { ADMIN_SESSION_COOKIE, createAdminSession, verifyAdminPassword } from "@/lib/security/admin-auth";
import { apiError } from "@/lib/utils/api";

const schema = z.object({ password: z.string().min(1).max(512) });
const globalState = globalThis as typeof globalThis & {
  neraxonLoginAttempts?: Map<string, { failures: number; blockedUntil: number }>;
};
const attempts = globalState.neraxonLoginAttempts ?? new Map<string, { failures: number; blockedUntil: number }>();
globalState.neraxonLoginAttempts = attempts;

export async function POST(request: Request) {
  try {
    const clientId = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || request.headers.get("x-real-ip")?.trim()
      || "unknown";
    const current = attempts.get(clientId);
    if (current && current.blockedUntil > Date.now()) {
      return NextResponse.json({ error: "Too many login attempts. Try again later." }, { status: 429 });
    }
    const { password } = schema.parse(await request.json());
    if (!verifyAdminPassword(password)) {
      const failures = (current?.failures ?? 0) + 1;
      attempts.set(clientId, {
        failures,
        blockedUntil: failures >= 5 ? Date.now() + 15 * 60_000 : 0,
      });
      return NextResponse.json({ error: "Invalid password." }, { status: 401 });
    }
    attempts.delete(clientId);
    const session = createAdminSession();
    const response = NextResponse.json({ authenticated: true });
    response.cookies.set(ADMIN_SESSION_COOKIE, session.value, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: session.maxAge,
    });
    return response;
  } catch (error) {
    return apiError(error, 401);
  }
}
