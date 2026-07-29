import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { userInfo } from "node:os";
import { promisify } from "node:util";
import { stdin, stdout } from "node:process";
import { Api, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";

const execFileAsync = promisify(execFile);
const API_ID_SERVICE = process.env.NERAXON_TELEGRAM_API_ID_SERVICE || "com.neraxon.telegram-user-api-id";
const API_HASH_SERVICE = process.env.NERAXON_TELEGRAM_API_HASH_SERVICE || "com.neraxon.telegram-user-api-hash";
const SESSION_SERVICE = process.env.NERAXON_TELEGRAM_SESSION_SERVICE || "com.neraxon.telegram-user-session";
const ACCOUNT = process.env.NERAXON_TELEGRAM_USER_KEYCHAIN_ACCOUNT || process.env.USER || userInfo().username;

async function readKeychain(service) {
  try {
    const { stdout: value } = await execFileAsync("/usr/bin/security", [
      "find-generic-password", "-s", service, "-a", ACCOUNT, "-w",
    ], { timeout: 10_000, maxBuffer: 262_144 });
    if (!value.trim()) throw new Error("Boş kayıt");
    return value.trim();
  } catch {
    throw new Error(`Keychain kaydı bulunamadı: ${service}`);
  }
}

async function writeKeychain(service, value) {
  await execFileAsync("/usr/bin/security", [
    "add-generic-password", "-U", "-s", service, "-a", ACCOUNT, "-w", value,
  ], { timeout: 10_000, maxBuffer: 262_144 });
}

async function hiddenPrompt(label) {
  if (!stdin.isTTY || !stdin.setRawMode) throw new Error("Bu komut etkileşimli bir terminalde çalıştırılmalı.");
  stdout.write(label);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Giriş iptal edildi."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };
    stdin.on("data", onData);
  });
}

function safeDisplayName(me) {
  const firstName = typeof me?.firstName === "string" ? me.firstName : "";
  const lastName = typeof me?.lastName === "string" ? me.lastName : "";
  return `${firstName} ${lastName}`.trim() || "Telegram hesabı";
}

function normalizePhoneNumber(value) {
  const compact = value.trim().replace(/[\s()-]/g, "");
  if (/^5\d{9}$/.test(compact)) return `+90${compact}`;
  if (/^05\d{9}$/.test(compact)) return `+90${compact.slice(1)}`;
  if (/^90\d{10}$/.test(compact)) return `+${compact}`;
  if (/^\+\d{10,15}$/.test(compact)) return compact;
  throw new Error("Telefon numarası geçersiz. 5XXXXXXXXX, 05XXXXXXXXX veya +905XXXXXXXXX biçimini kullan.");
}

function authenticationErrorMessage(error) {
  const code = typeof error?.errorMessage === "string" ? error.errorMessage : "";
  if (code === "PHONE_CODE_INVALID") return "Telegram doğrulama kodu hatalı.";
  if (code === "PHONE_CODE_EXPIRED") return "Telegram doğrulama kodunun süresi doldu.";
  if (code === "PASSWORD_HASH_INVALID") return "Telegram 2FA parolası hatalı.";
  if (code === "PHONE_NUMBER_INVALID") return "Telegram telefon numarasını kabul etmedi.";
  if (code === "PHONE_NUMBER_BANNED") return "Bu telefon numarası Telegram tarafından kısıtlanmış.";
  if (code === "FLOOD_WAIT") return "Çok fazla giriş denemesi yapıldı; Telegram bekleme uyguladı.";
  return error instanceof Error ? error.message : "Telegram doğrulama hatası.";
}

async function loadCredentials() {
  const [apiIdValue, apiHash] = await Promise.all([
    readKeychain(API_ID_SERVICE),
    readKeychain(API_HASH_SERVICE),
  ]);
  const apiId = Number(apiIdValue);
  if (!Number.isSafeInteger(apiId) || apiId <= 0) throw new Error("Keychain içindeki API ID geçersiz.");
  if (!/^[a-fA-F0-9]{32}$/.test(apiHash)) throw new Error("Keychain içindeki API hash geçersiz.");
  return { apiId, apiHash };
}

async function verifySession(apiId, apiHash, sessionValue) {
  const client = new TelegramClient(new StringSession(sessionValue), apiId, apiHash, {
    connectionRetries: 5,
    floodSleepThreshold: 30,
  });
  try {
    await client.connect();
    if (!await client.checkAuthorization()) throw new Error("Kaydedilmiş Telegram oturumu artık yetkili değil.");
    const me = await client.getMe();
    stdout.write(`Telegram bağlantısı doğrulandı: ${safeDisplayName(me)}\n`);
  } finally {
    await client.disconnect();
  }
}

async function listForumTopics(apiId, apiHash, sessionValue) {
  const client = new TelegramClient(new StringSession(sessionValue), apiId, apiHash, {
    connectionRetries: 5,
    floodSleepThreshold: 30,
  });
  try {
    await client.connect();
    if (!await client.checkAuthorization()) throw new Error("Kaydedilmiş Telegram oturumu artık yetkili değil.");
    const me = await client.getMe();
    stdout.write(`Yetkili kullanıcı · ${String(me.id)}\n`);
    const dialogs = await client.getDialogs({ limit: 500 });
    const forums = dialogs.filter((dialog) => dialog.entity?.forum);
    for (const dialog of forums) {
      const peer = await client.getInputEntity(dialog.entity);
      const result = await client.invoke(new Api.messages.GetForumTopics({
        peer,
        offsetDate: 0,
        offsetId: 0,
        offsetTopic: 0,
        limit: 100,
      }));
      const chatId = String(dialog.id);
      stdout.write(`${dialog.title || "İsimsiz forum"} · ${chatId}\n`);
      for (const topic of result.topics) {
        if (topic.className !== "ForumTopic") continue;
        stdout.write(`  ${topic.title} · topic ${topic.id}\n`);
      }
    }
  } finally {
    await client.disconnect();
  }
}

async function login(apiId, apiHash) {
  const readline = createInterface({ input: stdin, output: stdout });
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
    floodSleepThreshold: 30,
  });
  let lastError = null;
  let errorCount = 0;
  try {
    const phoneNumber = normalizePhoneNumber(await readline.question("Telefon numarası: "));
    stdout.write(`Doğrulama kodu ${phoneNumber} numaralı Telegram hesabına gönderiliyor.\n`);
    await client.start({
      phoneNumber,
      phoneCode: async () => {
        readline.close();
        return (await hiddenPrompt("Telegram doğrulama kodu: ")).trim();
      },
      password: async () => (await hiddenPrompt("Telegram 2FA parolası: ")).trim(),
      onError: (error) => {
        lastError = error;
        errorCount += 1;
        console.error(authenticationErrorMessage(error));
        return errorCount >= 3;
      },
    });
    if (!await client.checkAuthorization()) throw lastError || new Error("Telegram yetkilendirmesi tamamlanamadı.");
    const sessionValue = client.session.save();
    await writeKeychain(SESSION_SERVICE, sessionValue);
    const me = await client.getMe();
    stdout.write(`Oturum Keychain'e kaydedildi: ${safeDisplayName(me)}\n`);
    stdout.write("Ham mesaj saklama ve AI aktarımı varsayılan olarak kapalıdır.\n");
  } finally {
    readline.close();
    await client.disconnect();
  }
}

async function main() {
  const { apiId, apiHash } = await loadCredentials();
  if (process.argv.includes("--forums")) {
    await listForumTopics(apiId, apiHash, await readKeychain(SESSION_SERVICE));
    return;
  }
  if (process.argv.includes("--check")) {
    await verifySession(apiId, apiHash, await readKeychain(SESSION_SERVICE));
    return;
  }
  await login(apiId, apiHash);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Telegram oturum işlemi başarısız.");
  process.exitCode = 1;
});
