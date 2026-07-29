export function errorMessage(error: unknown, fallback = "Beklenmeyen bir hata oluştu.") {
  const rawMessage = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return rawMessage.trim() || fallback;
}
