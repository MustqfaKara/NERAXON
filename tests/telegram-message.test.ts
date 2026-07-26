import assert from "node:assert/strict";
import test from "node:test";
import { splitTelegramMessage } from "../src/lib/engine/telegram-message.ts";

test("uzun Telegram mesajı HTML sınırını aşmadan parçalara bölünür", () => {
  const parts = splitTelegramMessage("<b>[UYARI] Test</b>", `<teknik>&${"x".repeat(9_000)}`, 3_800);
  assert.ok(parts.length >= 3);
  assert.ok(parts.every((part) => part.length <= 3_800));
  assert.match(parts[0], /\(1\/\d+\)/);
  assert.match(parts.join(""), /&lt;teknik&gt;&amp;/);
});
