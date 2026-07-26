import { clearCredentialCache, readCredential } from "./credential-vault.ts";

export const GROQ_KEYCHAIN_SERVICE = "com.neraxon.groq-api";

let cachedGroqApiKey: string | null = null;

export async function readGroqApiKey() {
  if (cachedGroqApiKey) return cachedGroqApiKey;
  const apiKey = await readCredential("groq-api-key");
  if (!apiKey) throw new Error("Groq API anahtarı güvenli kasada bulunamadı.");
  cachedGroqApiKey = apiKey;
  return apiKey;
}

export function clearGroqApiKeyCache() {
  cachedGroqApiKey = null;
  clearCredentialCache("groq-api-key");
}
