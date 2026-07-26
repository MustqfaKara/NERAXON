import { readCredential, storeCredential } from "@/lib/security/credential-vault";

export const TELEGRAM_USER_API_ID_SERVICE = "com.neraxon.telegram-user-api-id";
export const TELEGRAM_USER_API_HASH_SERVICE = "com.neraxon.telegram-user-api-hash";
export const TELEGRAM_USER_SESSION_SERVICE = "com.neraxon.telegram-user-session";

export async function readTelegramUserCredentials() {
  const [apiIdValue, apiHash] = await Promise.all([
    readCredential("telegram-api-id", { allowEnvironment: false }),
    readCredential("telegram-api-hash", { allowEnvironment: false }),
  ]);
  if (!apiIdValue || !apiHash) throw new Error("Telegram API kimlik bilgileri güvenli kasada bulunamadı.");
  const apiId = Number(apiIdValue);
  if (!Number.isSafeInteger(apiId) || apiId <= 0) {
    throw new Error("Telegram API ID geçerli bir pozitif tam sayı değil.");
  }
  if (!/^[a-fA-F0-9]{32}$/.test(apiHash)) {
    throw new Error("Telegram API hash 32 karakterlik hexadecimal değer olmalı.");
  }
  return { apiId, apiHash };
}

export async function readTelegramUserSession() {
  const session = await readCredential("telegram-session", { allowEnvironment: false });
  if (!session) throw new Error("Telegram oturumu güvenli kasada bulunamadı.");
  return session;
}

export async function storeTelegramUserSession(session: string) {
  const normalized = session.trim();
  if (normalized.length < 32) throw new Error("Telegram oturum dizesi geçersiz.");
  await storeCredential("telegram-session", normalized);
}

export async function getTelegramUserCredentialStatus() {
  try {
    await readTelegramUserCredentials();
    let sessionConfigured = false;
    try {
      await readTelegramUserSession();
      sessionConfigured = true;
    } catch {
      sessionConfigured = false;
    }
    return { apiCredentialsConfigured: true, sessionConfigured };
  } catch {
    return { apiCredentialsConfigured: false, sessionConfigured: false };
  }
}
