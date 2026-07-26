import { NextResponse } from "next/server";
import { z } from "zod";
import { store } from "@/lib/repositories/store";
import { publishEvent } from "@/lib/services/audit-service";
import { apiError } from "@/lib/utils/api";
import { assertSameOrigin } from "@/lib/security/same-origin";
import { deletePrivateKey, getStoredCredentialStatus, storePrivateKey } from "@/lib/security/keychain";
import { getExecutionAccount, setExecutionAccount, type ExecutionAccountKind } from "@/lib/services/execution-account-service";
import { credentialBackend } from "@/lib/security/credential-vault";

const schema = z.object({
  privateKey: z.string().min(32).max(512).optional(),
  address: z.string().trim().min(20).max(128).optional(),
  credential: z.enum(["evm", "hyperliquid-agent", "solana"]).default("evm"),
}).refine((input) => Number(Boolean(input.privateKey)) + Number(Boolean(input.address)) === 1, {
  message: "Private key veya public adres seçeneklerinden yalnızca biri gönderilmeli.",
});

const accountKind = (credential: "evm" | "hyperliquid-agent" | "solana"): ExecutionAccountKind => credential === "hyperliquid-agent" ? "hyperliquid" : credential;

const credentialFromRequest = (request: Request) => {
  const value = new URL(request.url).searchParams.get("credential");
  return value === "hyperliquid-agent" || value === "solana" ? value : "evm";
};

export async function GET(request: Request) {
  const credential = credentialFromRequest(request);
  const status = await getStoredCredentialStatus(credential);
  return NextResponse.json({ ...status, address: status.address ?? getExecutionAccount(accountKind(credential)), backend: credentialBackend() }, { headers: { "cache-control": "no-store" } });
}

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    if (store.listChains().some((chain) => chain.status !== "stopped")) throw new Error("Anahtar değiştirilmeden önce bütün ağ botları durdurulmalı.");
    const { privateKey, address: publicAddress, credential } = schema.parse(await request.json());
    if (publicAddress) {
      const address = setExecutionAccount(accountKind(credential), publicAddress);
      await publishEvent({ chainId: null, level: "warning", type: "system", title: "İşlem hesabı güncellendi", message: `${address} public adresi bakiye ve işlem doğrulamalarında kullanılacak.`, txHash: null });
      const status = await getStoredCredentialStatus(credential);
      return NextResponse.json({ ...status, address, backend: credentialBackend() }, { headers: { "cache-control": "no-store" } });
    }
    const address = await storePrivateKey(credential, privateKey!);
    setExecutionAccount(accountKind(credential), address);
    const title = credential === "evm" ? "Canlı EVM cüzdanı yapılandırıldı" : credential === "solana" ? "Canlı Solana cüzdanı yapılandırıldı" : "Hyperliquid agent yapılandırıldı";
    await publishEvent({ chainId: null, level: "critical", type: "system", title, message: `${address} adresinin imzalama anahtarı güvenli kasaya kaydedildi.`, txHash: null });
    return NextResponse.json({ configured: true, address, backend: credentialBackend() }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    if (store.listChains().some((chain) => chain.status !== "stopped")) throw new Error("Anahtar silinmeden önce bütün ağ botları durdurulmalı.");
    const credential = credentialFromRequest(request);
    await deletePrivateKey(credential);
    const title = credential === "evm" ? "Canlı EVM cüzdanı kaldırıldı" : credential === "solana" ? "Canlı Solana cüzdanı kaldırıldı" : "Hyperliquid agent kaldırıldı";
    await publishEvent({ chainId: null, level: "critical", type: "system", title, message: "NERAXON imzalama anahtarı güvenli kasadan silindi.", txHash: null });
    return NextResponse.json({ configured: false, address: null });
  } catch (error) {
    return apiError(error);
  }
}
