import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "neraxon_admin_session";
const PUBLIC_PATHS = new Set(["/login", "/api/auth/login", "/api/health"]);

function base64UrlToBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function validSession(value: string | undefined, secret: string) {
  if (!value) return false;
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const verified = await crypto.subtle.verify(
    "HMAC",
    key,
    base64UrlToBytes(signature),
    new TextEncoder().encode(payload),
  );
  if (!verified) return false;
  try {
    const session = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload))) as { role?: string; expiresAt?: number };
    return session.role === "admin" && Number(session.expiresAt) > Math.floor(Date.now() / 1_000);
  } catch {
    return false;
  }
}

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (PUBLIC_PATHS.has(path)) return NextResponse.next();

  const password = process.env.NERAXON_ADMIN_PASSWORD?.trim() || "";
  const secret = process.env.NERAXON_SESSION_SECRET?.trim() || "";
  const isLocalRequest = ["localhost", "127.0.0.1"].includes(request.nextUrl.hostname);
  if ((!password || !secret) && isLocalRequest) return NextResponse.next();
  if (password.length < 16 || secret.length < 32) {
    return new NextResponse("Server authentication is not configured.", { status: 503 });
  }

  const authenticated = await validSession(request.cookies.get(COOKIE_NAME)?.value, secret);
  if (authenticated) {
    if (path === "/login") return NextResponse.redirect(new URL("/overview", request.url));
    return NextResponse.next();
  }
  if (path.startsWith("/api/")) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", `${path}${request.nextUrl.search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|neraxon-symbol-v2.png).*)"],
};
