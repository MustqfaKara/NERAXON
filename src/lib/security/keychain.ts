import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { deleteCredential, readCredential, readCredentialSync, storeCredential, type CredentialId } from "@/lib/security/credential-vault";

export const NERAXON_KEYCHAIN_SERVICE = "com.neraxon.live-wallet";
export type KeychainCredential = "evm" | "hyperliquid-agent" | "solana";

function credentialId(credential: KeychainCredential): CredentialId {
  if (credential === "evm") return "evm-private-key";
  if (credential === "solana") return "solana-private-key";
  return "hyperliquid-agent-private-key";
}

export function normalizePrivateKey(value: string): Hex {
  const normalized = value.trim().startsWith("0x") ? value.trim() : `0x${value.trim()}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) throw new Error("Private key 32 byte hexadecimal değer olmalı.");
  return normalized as Hex;
}

export function addressFromPrivateKey(value: string): Address {
  return privateKeyToAccount(normalizePrivateKey(value)).address;
}

export function normalizeSolanaSecret(value: string) {
  let bytes: Uint8Array;
  const trimmed = value.trim();
  try {
    bytes = trimmed.startsWith("[") ? Uint8Array.from(JSON.parse(trimmed) as number[]) : bs58.decode(trimmed);
  } catch {
    throw new Error("Solana anahtarı base58 veya 64 baytlık JSON secret key olmalı.");
  }
  const keypair = bytes.length === 32 ? Keypair.fromSeed(bytes) : bytes.length === 64 ? Keypair.fromSecretKey(bytes) : null;
  if (!keypair) throw new Error("Solana secret key 32 bayt seed veya 64 bayt keypair olmalı.");
  return { encoded: bs58.encode(keypair.secretKey), keypair };
}

export async function storePrivateKey(credential: KeychainCredential, value: string): Promise<string> {
  const normalized = credential === "solana" ? normalizeSolanaSecret(value) : null;
  const privateKey = normalized?.encoded ?? normalizePrivateKey(value);
  const address = normalized?.keypair.publicKey.toBase58() ?? privateKeyToAccount(privateKey as Hex).address;
  await storeCredential(credentialId(credential), privateKey);
  return address;
}

async function readCredentialValue(credential: KeychainCredential): Promise<string> {
  const value = await readCredential(credentialId(credential), { allowEnvironment: false });
  if (!value) throw new Error("NERAXON imzalama anahtarı güvenli kasada bulunamadı.");
  return value;
}

export async function readPrivateKey(credential: Exclude<KeychainCredential, "solana">): Promise<Hex> {
  return normalizePrivateKey(await readCredentialValue(credential));
}

export async function readSolanaKeypair() {
  return normalizeSolanaSecret(await readCredentialValue("solana")).keypair;
}

export async function getStoredCredentialStatus(credential: KeychainCredential) {
  try {
    if (credential === "solana") {
      const keypair = await readSolanaKeypair();
      return { configured: true, address: keypair.publicKey.toBase58() };
    }
    const privateKey = await readPrivateKey(credential);
    return { configured: true, address: privateKeyToAccount(privateKey).address };
  } catch {
    return { configured: false, address: null };
  }
}

export function getStoredCredentialStatusSync(credential: KeychainCredential) {
  try {
    const stored = readCredentialSync(credentialId(credential), { allowEnvironment: false });
    if (!stored) throw new Error("Credential is not configured.");
    if (credential === "solana") {
      return { configured: true, address: normalizeSolanaSecret(stored).keypair.publicKey.toBase58() };
    }
    return { configured: true, address: privateKeyToAccount(normalizePrivateKey(stored)).address };
  } catch {
    return { configured: false, address: null };
  }
}

export async function deletePrivateKey(credential: KeychainCredential) {
  await deleteCredential(credentialId(credential));
}
