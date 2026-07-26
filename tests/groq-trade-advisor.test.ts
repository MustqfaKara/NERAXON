import assert from "node:assert/strict";
import test from "node:test";
import { GroqTradeAdvisor } from "../src/lib/ai/groq-trade-advisor.ts";

const context = {
  chainId: "base",
  mode: "shadow",
  side: "buy" as const,
  asset: "TOKEN",
  walletScore: 78,
  walletConfirmations: 3,
  priceUsd: 0.25,
  priceChange24hPercent: 12,
  liquidityUsd: 80_000,
  volume24hUsd: 240_000,
  marketCapUsd: 1_200_000,
  safetyScore: 84,
  safetyWarnings: [],
  projectResearch: {
    website: {
      url: "https://example.com",
      reachable: true,
      title: "Example Protocol",
      description: "On-chain analytics protocol",
    },
    xProfiles: [{
      url: "https://x.com/example",
      handle: "example",
      reachable: true,
      profileSummary: "Official project profile",
    }],
    evidenceLimitations: [],
  },
};

test("Groq danışmanı strict JSON şemasıyla doğrulanmış karar döndürür", async () => {
  let requestBodyJson = "{}";
  const advisor = new GroqTradeAdvisor({
    apiKeyReader: async () => "test-key",
    fetchImpl: async (_url, init) => {
      requestBodyJson = String(init?.body);
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              recommendation: "review",
              confidence: 0.82,
              riskLevel: "medium",
              summaryTr: "Likidite yeterli ancak fiyat hareketi ayrıca izlenmeli.",
              summaryEn: "Liquidity is sufficient, but price movement needs monitoring.",
              projectPurposeTr: "Proje amacı test verisinde belirtilmedi.",
              projectPurposeEn: "The project purpose was not provided in test data.",
              socialAssessmentTr: "X hesabı test verisinde bulunmuyor.",
              socialAssessmentEn: "No X account is present in the test data.",
              riskFlagsTr: ["Kısa vadeli volatilite"],
              riskFlagsEn: ["Short-term volatility"],
            }),
          },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const decision = await advisor.analyze(context);
  const requestBody = JSON.parse(requestBodyJson) as {
    response_format: { json_schema: { strict: boolean } };
    messages: Array<{ role: string; content: string }>;
    tool_choice?: string;
  };

  assert.equal(decision.recommendation, "review");
  assert.equal(decision.confidence, 0.82);
  assert.equal(requestBody.response_format.json_schema.strict, true);
  assert.equal(requestBody.tool_choice, undefined);
  assert.match(requestBody.messages[1].content, /On-chain analytics protocol/u);
});

test("Groq danışmanı şemaya uymayan çıktıyı kabul etmez", async () => {
  const advisor = new GroqTradeAdvisor({
    apiKeyReader: async () => "test-key",
    fetchImpl: async () => new Response(JSON.stringify({
      output_text: JSON.stringify({ recommendation: "buy-now" }),
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });

  await assert.rejects(() => advisor.analyze(context));
});

test("Groq servis hatası kullanıcı anahtarını hata mesajına taşımaz", async () => {
  const advisor = new GroqTradeAdvisor({
    apiKeyReader: async () => "secret-test-key",
    fetchImpl: async () => new Response(JSON.stringify({
      error: { message: "Rate limit aşıldı." },
    }), { status: 429, headers: { "content-type": "application/json" } }),
  });

  await assert.rejects(
    () => advisor.analyze(context),
    (error: unknown) => error instanceof Error
      && /Rate limit/u.test(error.message)
      && !error.message.includes("secret-test-key"),
  );
});

test("Groq tanımsız araç çağrısı hatasını yalnızca bir kez yeniden dener", async () => {
  let requestCount = 0;
  const advisor = new GroqTradeAdvisor({
    apiKeyReader: async () => "test-key",
    fetchImpl: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(JSON.stringify({
          error: { message: "Tool choice is none, but model called a tool" },
        }), { status: 400, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          recommendation: "proceed",
          confidence: 0.75,
          riskLevel: "low",
          summaryTr: "Kontroller olumlu.",
          summaryEn: "Checks are positive.",
          projectPurposeTr: "Proje amacı bilinmiyor.",
          projectPurposeEn: "The project purpose is unknown.",
          socialAssessmentTr: "Sosyal profil verisi yok.",
          socialAssessmentEn: "No social profile data is available.",
          riskFlagsTr: [],
          riskFlagsEn: [],
        }),
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const decision = await advisor.analyze(context);

  assert.equal(decision.recommendation, "proceed");
  assert.equal(requestCount, 2);
});

test("Groq JSON üretim hatasını yalnızca bir kez yeniden dener", async () => {
  let requestCount = 0;
  const advisor = new GroqTradeAdvisor({
    apiKeyReader: async () => "test-key",
    fetchImpl: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(JSON.stringify({
          error: { message: "Failed to generate JSON. Please adjust your prompt." },
        }), { status: 400, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          recommendation: "review",
          confidence: 0.68,
          riskLevel: "medium",
          summaryTr: "Piyasa koşulları ayrıca incelenmeli.",
          summaryEn: "Market conditions require additional review.",
          projectPurposeTr: "Proje amacı sınırlı kanıtla değerlendirildi.",
          projectPurposeEn: "The project purpose was assessed with limited evidence.",
          socialAssessmentTr: "Sosyal profil kanıtı sınırlı.",
          socialAssessmentEn: "Social profile evidence is limited.",
          riskFlagsTr: ["Yüksek oynaklık"],
          riskFlagsEn: ["High volatility"],
        }),
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const decision = await advisor.analyze(context);

  assert.equal(decision.recommendation, "review");
  assert.equal(requestCount, 2);
});
