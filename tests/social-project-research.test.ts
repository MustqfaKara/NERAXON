import assert from "node:assert/strict";
import test from "node:test";
import {
  extractPageMetadata,
  inspectPublicPage,
} from "../src/lib/services/social-project-research.ts";

test("proje sayfasından amaç için başlık ve açıklama çıkarır", () => {
  const metadata = extractPageMetadata(`
    <html>
      <head>
        <title>GreenPad</title>
        <meta property="og:description" content="A launchpad for community-owned green projects.">
      </head>
    </html>
  `);

  assert.deepEqual(metadata, {
    title: "GreenPad",
    description: "A launchpad for community-owned green projects.",
  });
});

test("herkese açık HTTPS sayfasının sınırlı metadata içeriğini okur", async () => {
  const result = await inspectPublicPage("https://example.com/project", {
    resolveHost: async () => ["93.184.216.34"],
    fetchImpl: async () => new Response(`
      <title>Project</title>
      <meta name="description" content="On-chain analytics protocol">
    `, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
  });

  assert.equal(result.reachable, true);
  assert.equal(result.title, "Project");
  assert.equal(result.description, "On-chain analytics protocol");
});

test("özel ağ adresine çözünen proje bağlantısını engeller", async () => {
  await assert.rejects(() => inspectPublicPage("https://project.example", {
    resolveHost: async () => ["127.0.0.1"],
    fetchImpl: async () => {
      throw new Error("Bu istek çalışmamalı.");
    },
  }), /Güvenli olmayan/u);
});
