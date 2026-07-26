import { TelegramClient, Api } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { computeCheck } from "teleproto/Password.js";
import { readTelegramUserCredentials } from "@/lib/security/telegram-user-keychain";
import { storeCredential } from "@/lib/security/credential-vault";

interface PendingTelegramLogin {
  client: TelegramClient<StringSession>;
  phoneNumber: string;
  phoneCodeHash: string;
  expiresAt: number;
}

const LOGIN_TTL_MS = 10 * 60_000;
const globalState = globalThis as typeof globalThis & {
  neraxonPendingTelegramLogins?: Map<string, PendingTelegramLogin>;
};
const pendingLogins = globalState.neraxonPendingTelegramLogins ?? new Map<string, PendingTelegramLogin>();
globalState.neraxonPendingTelegramLogins = pendingLogins;

function normalizePhoneNumber(value: string) {
  const normalized = value.trim().replace(/[\s()-]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw new Error("Telefon numarası ülke koduyla birlikte +905... biçiminde olmalı.");
  }
  return normalized;
}

async function clearExpiredLogins() {
  const now = Date.now();
  const expired = [...pendingLogins.entries()].filter(([, login]) => login.expiresAt <= now);
  await Promise.all(expired.map(async ([id, login]) => {
    pendingLogins.delete(id);
    await login.client.disconnect().catch(() => undefined);
  }));
}

export async function requestTelegramLoginCode(rawPhoneNumber: string) {
  await clearExpiredLogins();
  const phoneNumber = normalizePhoneNumber(rawPhoneNumber);
  const credentials = await readTelegramUserCredentials();
  const client = new TelegramClient(new StringSession(""), credentials.apiId, credentials.apiHash, {
    connectionRetries: 5,
    floodSleepThreshold: 30,
  });
  await client.connect();
  try {
    const result = await client.sendCode(credentials, phoneNumber);
    if (result.emailRequired || result.emailCodeSent) {
      throw new Error("Bu Telegram hesabı e-posta doğrulaması istiyor; web oturum akışı şu anda bu yöntemi desteklemiyor.");
    }
    const loginId = crypto.randomUUID();
    pendingLogins.set(loginId, {
      client,
      phoneNumber,
      phoneCodeHash: result.phoneCodeHash,
      expiresAt: Date.now() + LOGIN_TTL_MS,
    });
    return { loginId, delivery: result.isCodeViaApp ? "telegram" : "sms", expiresInSeconds: LOGIN_TTL_MS / 1_000 };
  } catch (error) {
    await client.disconnect().catch(() => undefined);
    throw error;
  }
}

export async function confirmTelegramLoginCode(loginId: string, code: string) {
  await clearExpiredLogins();
  const pending = getPendingLogin(loginId);
  try {
    const result = await pending.client.invoke(new Api.auth.SignIn({
      phoneNumber: pending.phoneNumber,
      phoneCodeHash: pending.phoneCodeHash,
      phoneCode: code.trim(),
    }));
    if (result instanceof Api.auth.AuthorizationSignUpRequired) {
      throw new Error("Yeni Telegram hesabı oluşturma bu panelde desteklenmiyor.");
    }
    return completeTelegramLogin(loginId, pending);
  } catch (error) {
    if (telegramErrorCode(error) === "SESSION_PASSWORD_NEEDED") {
      return { authenticated: false, requiresPassword: true };
    }
    throw new Error(telegramLoginError(error));
  }
}

export async function confirmTelegramLoginPassword(loginId: string, password: string) {
  await clearExpiredLogins();
  const pending = getPendingLogin(loginId);
  try {
    const passwordState = await pending.client.invoke(new Api.account.GetPassword());
    const passwordCheck = await computeCheck(passwordState, password);
    await pending.client.invoke(new Api.auth.CheckPassword({ password: passwordCheck }));
    return completeTelegramLogin(loginId, pending);
  } catch (error) {
    throw new Error(telegramLoginError(error));
  }
}

async function completeTelegramLogin(loginId: string, pending: PendingTelegramLogin) {
  const session = pending.client.session.save();
  if (!session || session.length < 32) throw new Error("Telegram oturumu üretilemedi.");
  await storeCredential("telegram-session", session);
  pendingLogins.delete(loginId);
  await pending.client.disconnect();
  return { authenticated: true, requiresPassword: false };
}

function getPendingLogin(loginId: string) {
  const pending = pendingLogins.get(loginId);
  if (!pending || pending.expiresAt <= Date.now()) throw new Error("Telegram doğrulama oturumunun süresi doldu.");
  return pending;
}

function telegramErrorCode(error: unknown) {
  return typeof error === "object" && error && "errorMessage" in error
    ? String((error as { errorMessage?: unknown }).errorMessage ?? "")
    : "";
}

function telegramLoginError(error: unknown) {
  const code = telegramErrorCode(error);
  if (code === "PHONE_CODE_INVALID") return "Telegram doğrulama kodu hatalı.";
  if (code === "PHONE_CODE_EXPIRED") return "Telegram doğrulama kodunun süresi doldu.";
  if (code === "PASSWORD_HASH_INVALID") return "Telegram 2FA parolası hatalı.";
  if (code.startsWith("FLOOD_WAIT")) return "Telegram çok fazla deneme nedeniyle geçici bekleme uyguladı.";
  return error instanceof Error ? error.message : "Telegram doğrulaması tamamlanamadı.";
}
