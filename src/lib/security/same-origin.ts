export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) throw new Error("Hassas işlem için origin doğrulaması gerekli.");
  const originUrl = new URL(origin);
  if (originUrl.host !== host || !["http:", "https:"].includes(originUrl.protocol)) {
    throw new Error("İstek kaynağı doğrulanamadı.");
  }
  if (!["127.0.0.1", "localhost"].includes(originUrl.hostname)) {
    throw new Error("Hassas işlemler yalnızca bu Mac üzerindeki yerel arayüzden yapılabilir.");
  }
}
