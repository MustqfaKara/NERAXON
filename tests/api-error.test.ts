import assert from "node:assert/strict";
import test from "node:test";
import { errorMessage } from "../src/lib/utils/error-message.ts";

test("boş hata mesajını kullanıcıya göstermeden açıklayıcı varsayılan döndürür", () => {
  assert.equal(errorMessage(new Error("")), "Beklenmeyen bir hata oluştu.");
  assert.equal(errorMessage("   "), "Beklenmeyen bir hata oluştu.");
});

test("anlamlı hata mesajını boşluklardan arındırarak korur", () => {
  assert.equal(errorMessage(new Error(" Swap rotası bulunamadı. ")), "Swap rotası bulunamadı.");
});
