import test from "node:test";
import assert from "node:assert/strict";
import { notificationRetryDelayMs, shouldDeadLetterNotification } from "../src/lib/engine/notification-retry.ts";

test("Telegram retry beklemesini artan ve sınırlı hesaplar", () => {
  assert.equal(notificationRetryDelayMs(1), 30_000);
  assert.equal(notificationRetryDelayMs(2), 60_000);
  assert.equal(notificationRetryDelayMs(6), 900_000);
  assert.equal(notificationRetryDelayMs(20), 900_000);
});

test("kalıcı Telegram hataları ve tükenen denemeler dead-letter olur", () => {
  assert.equal(shouldDeadLetterNotification("Bad Request: chat not found", 1), true);
  assert.equal(shouldDeadLetterNotification("Too Many Requests", 9), false);
  assert.equal(shouldDeadLetterNotification("Too Many Requests", 10), true);
});
