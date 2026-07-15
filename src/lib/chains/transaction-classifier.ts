import type { ActivityType } from "@/lib/domain/types";

const SWAP_SELECTORS = new Set([
  "0x3593564c", "0x24856bc3", "0x38ed1739", "0x8803dbee", "0x7ff36ab5",
  "0x18cbafe5", "0x5c11d795", "0xb6f9de95", "0x791ac947", "0x4a25d94a",
  "0xfb3bdb41", "0x414bf389", "0xc04b8d59", "0xdb3e2198", "0xf28c0498",
  "0x12aa3caf", "0x2e95b6c8", "0xe449022e", "0x415565b0", "0xd9627aa4",
]);
const LIQUIDITY_ADD_SELECTORS = new Set(["0xe8e33700", "0xf305d719", "0x88316456"]);
const LIQUIDITY_REMOVE_SELECTORS = new Set(["0xbaa2abde", "0x02751cec", "0x2195995c", "0x0c49ccbe"]);
const APPROVAL_SELECTORS = new Set(["0x095ea7b3", "0xa22cb465"]);

const KNOWN_SWAP_ROUTERS = new Set([
  "0x7a250d5630b4cf539739df2c5dacb4c659f2488d",
  "0xe592427a0aece92de3edee1f18e0157c05861564",
  "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
  "0x3fc91a3afd70395cd496c647d5a6cc9d4b2fadad",
  "0x198ef79f1f515f02dfe9e3115ed9fc07183f02fc",
]);

interface InspectionContext {
  targetAddress: string | null;
  nativeValue: number;
  tokenMovements: Array<{ direction: "in" | "out" }>;
}

export interface TransactionClassification {
  activity: ActivityType;
  reason: string;
}

export function classifyTransaction(input: string): ActivityType {
  const selector = input.slice(0, 10).toLowerCase();
  if (SWAP_SELECTORS.has(selector)) return "swap";
  if (LIQUIDITY_ADD_SELECTORS.has(selector)) return "liquidity_add";
  if (LIQUIDITY_REMOVE_SELECTORS.has(selector)) return "liquidity_remove";
  if (APPROVAL_SELECTORS.has(selector)) return "approval";
  if (input === "0x") return "transfer";
  return "unknown";
}

export function classifyTransactionWithInspection(input: string, inspection: InspectionContext): TransactionClassification {
  const selectorActivity = classifyTransaction(input);
  if (selectorActivity !== "unknown") {
    return { activity: selectorActivity, reason: "Metot selector bilinen işlem imzasıyla eşleşti." };
  }

  const targetAddress = inspection.targetAddress?.toLowerCase() ?? null;
  const hasIncoming = inspection.tokenMovements.some((movement) => movement.direction === "in");
  const hasOutgoing = inspection.tokenMovements.some((movement) => movement.direction === "out");
  if (targetAddress && KNOWN_SWAP_ROUTERS.has(targetAddress) && inspection.tokenMovements.length > 0) {
    return { activity: "swap", reason: "Hedef kontrat bilinen bir DEX router ve receipt token hareketi içeriyor." };
  }
  if (inspection.nativeValue > 0 && hasIncoming) {
    return { activity: "swap", reason: "Cüzdandan native varlık çıkışı ve cüzdana token girişi birlikte doğrulandı." };
  }
  if (hasIncoming && hasOutgoing) {
    return { activity: "swap", reason: "Receipt üzerinde cüzdan yönünde hem token çıkışı hem token girişi doğrulandı." };
  }
  if (inspection.tokenMovements.length > 0) {
    return { activity: "contract", reason: "Kontrat çağrısı token hareketi üretti ancak karşılıklı swap akışı doğrulanamadı." };
  }
  return { activity: "unknown", reason: "Selector, hedef kontrat ve receipt hareketleri işlem türünü belirlemek için yeterli değil." };
}

export function activityLabel(type: ActivityType): string {
  const labels: Record<ActivityType, string> = {
    swap: "Swap işlemi",
    liquidity_add: "Likidite ekleme",
    liquidity_remove: "Likidite çıkarma",
    transfer: "Transfer",
    approval: "Token izni",
    bridge: "Bridge işlemi",
    contract: "Kontrat işlemi",
    unknown: "Sınıflandırılmamış işlem",
    system: "Sistem olayı",
  };
  return labels[type];
}
