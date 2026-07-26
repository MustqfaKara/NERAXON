import { execFile, execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CredentialId =
  | "evm-private-key"
  | "solana-private-key"
  | "hyperliquid-agent-private-key"
  | "groq-api-key"
  | "telegram-api-id"
  | "telegram-api-hash"
  | "telegram-session"
  | "telegram-bot-token"
  | "telegram-chat-id"
  | "helius-api-key"
  | "jupiter-api-key"
  | "birdeye-api-key"
  | "zerox-api-key"
  | "etherscan-api-key"
  | "lifi-api-key"
  | "ethereum-rpc-url"
  | "ethereum-rpc-fallback-urls"
  | "base-rpc-url"
  | "base-rpc-fallback-urls"
  | "robinhood-rpc-url"
  | "robinhood-rpc-fallback-urls"
  | "solana-rpc-url"
  | "solana-ws-url"
  | "hyperliquid-info-url"
  | "hyperliquid-ws-url"
  | "hyperliquid-exchange-url";

type SecretBackend = "keychain" | "encrypted-file";

interface CredentialDefinition {
  service: string;
  accountEnv?: string;
  environment?: string;
}

interface EncryptedEntry {
  iv: string;
  tag: string;
  ciphertext: string;
}

interface EncryptedVaultFile {
  version: 1;
  entries: Partial<Record<CredentialId, EncryptedEntry>>;
}

const DEFAULT_ACCOUNT = process.env.USER?.trim() || userInfo().username;
const KEYCHAIN_SERVICE_PREFIX = "com.neraxon";

const CREDENTIALS: Record<CredentialId, CredentialDefinition> = {
  "evm-private-key": { service: `${KEYCHAIN_SERVICE_PREFIX}.live-wallet`, accountEnv: "NERAXON_EVM_KEYCHAIN_ACCOUNT" },
  "solana-private-key": { service: `${KEYCHAIN_SERVICE_PREFIX}.live-wallet`, accountEnv: "NERAXON_SOLANA_KEYCHAIN_ACCOUNT" },
  "hyperliquid-agent-private-key": { service: `${KEYCHAIN_SERVICE_PREFIX}.live-wallet`, accountEnv: "NERAXON_HYPERLIQUID_KEYCHAIN_ACCOUNT" },
  "groq-api-key": { service: `${KEYCHAIN_SERVICE_PREFIX}.groq-api`, accountEnv: "NERAXON_GROQ_KEYCHAIN_ACCOUNT" },
  "telegram-api-id": { service: `${KEYCHAIN_SERVICE_PREFIX}.telegram-user-api-id` },
  "telegram-api-hash": { service: `${KEYCHAIN_SERVICE_PREFIX}.telegram-user-api-hash` },
  "telegram-session": { service: `${KEYCHAIN_SERVICE_PREFIX}.telegram-user-session` },
  "telegram-bot-token": { service: `${KEYCHAIN_SERVICE_PREFIX}.telegram-bot-token`, environment: "TELEGRAM_BOT_TOKEN" },
  "telegram-chat-id": { service: `${KEYCHAIN_SERVICE_PREFIX}.telegram-chat-id`, environment: "TELEGRAM_CHAT_ID" },
  "helius-api-key": { service: `${KEYCHAIN_SERVICE_PREFIX}.helius-api-key`, environment: "HELIUS_API_KEY" },
  "jupiter-api-key": { service: `${KEYCHAIN_SERVICE_PREFIX}.jupiter-api-key`, environment: "JUPITER_API_KEY" },
  "birdeye-api-key": { service: `${KEYCHAIN_SERVICE_PREFIX}.birdeye-api-key`, environment: "BIRDEYE_API_KEY" },
  "zerox-api-key": { service: `${KEYCHAIN_SERVICE_PREFIX}.zerox-api-key`, environment: "ZEROX_API_KEY" },
  "etherscan-api-key": { service: `${KEYCHAIN_SERVICE_PREFIX}.etherscan-api-key`, environment: "ETHERSCAN_API_KEY" },
  "lifi-api-key": { service: `${KEYCHAIN_SERVICE_PREFIX}.lifi-api-key`, environment: "LIFI_API_KEY" },
  "ethereum-rpc-url": { service: `${KEYCHAIN_SERVICE_PREFIX}.ethereum-rpc-url`, environment: "ETHEREUM_RPC_URL" },
  "ethereum-rpc-fallback-urls": { service: `${KEYCHAIN_SERVICE_PREFIX}.ethereum-rpc-fallback-urls`, environment: "ETHEREUM_RPC_FALLBACK_URLS" },
  "base-rpc-url": { service: `${KEYCHAIN_SERVICE_PREFIX}.base-rpc-url`, environment: "BASE_RPC_URL" },
  "base-rpc-fallback-urls": { service: `${KEYCHAIN_SERVICE_PREFIX}.base-rpc-fallback-urls`, environment: "BASE_RPC_FALLBACK_URLS" },
  "robinhood-rpc-url": { service: `${KEYCHAIN_SERVICE_PREFIX}.robinhood-rpc-url`, environment: "ROBINHOOD_RPC_URL" },
  "robinhood-rpc-fallback-urls": { service: `${KEYCHAIN_SERVICE_PREFIX}.robinhood-rpc-fallback-urls`, environment: "ROBINHOOD_RPC_FALLBACK_URLS" },
  "solana-rpc-url": { service: `${KEYCHAIN_SERVICE_PREFIX}.solana-rpc-url`, environment: "SOLANA_RPC_URL" },
  "solana-ws-url": { service: `${KEYCHAIN_SERVICE_PREFIX}.solana-ws-url`, environment: "SOLANA_WS_URL" },
  "hyperliquid-info-url": { service: `${KEYCHAIN_SERVICE_PREFIX}.hyperliquid-info-url`, environment: "HYPERLIQUID_INFO_URL" },
  "hyperliquid-ws-url": { service: `${KEYCHAIN_SERVICE_PREFIX}.hyperliquid-ws-url`, environment: "HYPERLIQUID_WS_URL" },
  "hyperliquid-exchange-url": { service: `${KEYCHAIN_SERVICE_PREFIX}.hyperliquid-exchange-url`, environment: "HYPERLIQUID_EXCHANGE_URL" },
};

const cache = new Map<CredentialId, { value: string; source: SecretBackend | "environment" }>();

function backend(): SecretBackend {
  const configured = process.env.NERAXON_SECRET_BACKEND?.trim().toLowerCase();
  if (configured === "keychain" || configured === "encrypted-file") return configured;
  return process.platform === "darwin" ? "keychain" : "encrypted-file";
}

function accountName(id: CredentialId) {
  if (id === "evm-private-key") return process.env.NERAXON_EVM_KEYCHAIN_ACCOUNT?.trim() || "evm-main";
  if (id === "solana-private-key") return process.env.NERAXON_SOLANA_KEYCHAIN_ACCOUNT?.trim() || "solana-main";
  if (id === "hyperliquid-agent-private-key") return process.env.NERAXON_HYPERLIQUID_KEYCHAIN_ACCOUNT?.trim() || "hyperliquid-agent";
  const accountEnv = CREDENTIALS[id].accountEnv;
  return (accountEnv ? process.env[accountEnv]?.trim() : null) || process.env.NERAXON_KEYCHAIN_ACCOUNT?.trim() || DEFAULT_ACCOUNT;
}

const ENCRYPTED_VAULT_PATH = join(process.cwd(), "data", "credentials.vault.json");
const vaultPath = () => ENCRYPTED_VAULT_PATH;

function vaultKey() {
  const encoded = process.env.NERAXON_VAULT_MASTER_KEY?.trim();
  if (!encoded) throw new Error("NERAXON_VAULT_MASTER_KEY is required for the encrypted server vault.");
  const key = /^[a-fA-F0-9]{64}$/.test(encoded) ? Buffer.from(encoded, "hex") : Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("NERAXON_VAULT_MASTER_KEY must contain exactly 32 bytes.");
  return key;
}

function readVaultFile(): EncryptedVaultFile {
  const path = vaultPath();
  if (!existsSync(path)) return { version: 1, entries: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as EncryptedVaultFile;
  if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") {
    throw new Error("The encrypted credential vault has an unsupported format.");
  }
  return parsed;
}

function writeVaultFile(vault: EncryptedVaultFile) {
  const path = vaultPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(vault, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
}

function encrypt(value: string): EncryptedEntry {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", vaultKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decrypt(entry: EncryptedEntry) {
  const decipher = createDecipheriv("aes-256-gcm", vaultKey(), Buffer.from(entry.iv, "base64"));
  decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(entry.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function readFromKeychainSync(id: CredentialId) {
  return execFileSync("/usr/bin/security", [
    "find-generic-password",
    "-s",
    CREDENTIALS[id].service,
    "-a",
    accountName(id),
    "-w",
  ], { timeout: 5_000, maxBuffer: 262_144, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

async function readFromKeychain(id: CredentialId) {
  const { stdout } = await execFileAsync("/usr/bin/security", [
    "find-generic-password",
    "-s",
    CREDENTIALS[id].service,
    "-a",
    accountName(id),
    "-w",
  ], { timeout: 10_000, maxBuffer: 262_144 });
  return stdout.trim();
}

export function readCredentialSync(id: CredentialId, options: { allowEnvironment?: boolean } = {}) {
  const cached = cache.get(id);
  if (cached && (options.allowEnvironment !== false || cached.source !== "environment")) return cached.value;
  let value = "";
  let source: SecretBackend | "environment" = backend();
  try {
    value = backend() === "keychain"
      ? readFromKeychainSync(id)
      : decrypt(readVaultFile().entries[id]!);
  } catch {
    value = "";
  }
  if (!value && options.allowEnvironment !== false) {
    const environment = CREDENTIALS[id].environment;
    value = environment ? process.env[environment]?.trim() || "" : "";
    source = "environment";
  }
  if (value && source !== "environment") cache.set(id, { value, source });
  return value || null;
}

export async function readCredential(id: CredentialId, options: { allowEnvironment?: boolean } = {}) {
  const cached = cache.get(id);
  if (cached && (options.allowEnvironment !== false || cached.source !== "environment")) return cached.value;
  let value = "";
  let source: SecretBackend | "environment" = backend();
  try {
    value = backend() === "keychain"
      ? await readFromKeychain(id)
      : decrypt(readVaultFile().entries[id]!);
  } catch {
    value = "";
  }
  if (!value && options.allowEnvironment !== false) {
    const environment = CREDENTIALS[id].environment;
    value = environment ? process.env[environment]?.trim() || "" : "";
    source = "environment";
  }
  if (value && source !== "environment") cache.set(id, { value, source });
  return value || null;
}

export async function storeCredential(id: CredentialId, rawValue: string) {
  const value = rawValue.trim();
  if (!value) throw new Error("Credential value cannot be empty.");
  if (backend() === "keychain") {
    await execFileAsync("/usr/bin/security", [
      "add-generic-password",
      "-U",
      "-s",
      CREDENTIALS[id].service,
      "-a",
      accountName(id),
      "-w",
      value,
    ], { timeout: 10_000, maxBuffer: 262_144 });
  } else {
    const vault = readVaultFile();
    vault.entries[id] = encrypt(value);
    writeVaultFile(vault);
  }
  cache.set(id, { value, source: backend() });
}

export async function deleteCredential(id: CredentialId) {
  if (backend() === "keychain") {
    try {
      await execFileAsync("/usr/bin/security", [
        "delete-generic-password",
        "-s",
        CREDENTIALS[id].service,
        "-a",
        accountName(id),
      ], { timeout: 10_000, maxBuffer: 262_144 });
    } catch {
      throw new Error("Credential was not found in macOS Keychain.");
    }
  } else {
    const vault = readVaultFile();
    if (!vault.entries[id]) throw new Error("Credential was not found in the encrypted vault.");
    delete vault.entries[id];
    writeVaultFile(vault);
  }
  cache.delete(id);
}

export function credentialStatus(id: CredentialId) {
  const value = readCredentialSync(id);
  const source = cache.get(id)?.source
    ?? (CREDENTIALS[id].environment && process.env[CREDENTIALS[id].environment!]?.trim() ? "environment" : null);
  return {
    configured: Boolean(value),
    source,
  };
}

export function credentialBackend() {
  return backend();
}

export function clearCredentialCache(id?: CredentialId) {
  if (id) cache.delete(id);
  else cache.clear();
}
