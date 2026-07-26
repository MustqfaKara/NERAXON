import { createHmac, timingSafeEqual } from "node:crypto";

export const ADMIN_SESSION_COOKIE = "neraxon_admin_session";
const SESSION_DURATION_SECONDS = 12 * 60 * 60;

function adminPassword() {
  return process.env.NERAXON_ADMIN_PASSWORD?.trim() || "";
}

function sessionSecret() {
  return process.env.NERAXON_SESSION_SECRET?.trim() || "";
}

export function authConfigured() {
  return adminPassword().length >= 16 && sessionSecret().length >= 32;
}

export function assertAuthConfiguration() {
  if (!authConfigured()) {
    throw new Error("NERAXON_ADMIN_PASSWORD and NERAXON_SESSION_SECRET must be configured for server access.");
  }
}

export function verifyAdminPassword(value: string) {
  const expected = Buffer.from(adminPassword());
  const received = Buffer.from(value);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function createAdminSession() {
  assertAuthConfiguration();
  const payload = Buffer.from(JSON.stringify({
    role: "admin",
    expiresAt: Math.floor(Date.now() / 1_000) + SESSION_DURATION_SECONDS,
  })).toString("base64url");
  const signature = createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  return {
    value: `${payload}.${signature}`,
    maxAge: SESSION_DURATION_SECONDS,
  };
}
