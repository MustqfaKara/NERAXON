import test from "node:test";
import assert from "node:assert/strict";
import { assertLiveExecutionEnabled } from "../src/lib/execution/live-execution-switch.ts";

test("adaptör seviyesi kill-switch kapalıyken canlı gönderimi engeller", () => {
  const previous = process.env.LIVE_TRADING_ENABLED;
  process.env.LIVE_TRADING_ENABLED = "false";
  assert.throws(() => assertLiveExecutionEnabled(), /canlı emir gönderimi kilitli/i);
  if (previous === undefined) delete process.env.LIVE_TRADING_ENABLED;
  else process.env.LIVE_TRADING_ENABLED = previous;
});

test("adaptör seviyesi kill-switch yalnızca açıkça true ise geçer", () => {
  const previous = process.env.LIVE_TRADING_ENABLED;
  process.env.LIVE_TRADING_ENABLED = "true";
  assert.doesNotThrow(() => assertLiveExecutionEnabled());
  if (previous === undefined) delete process.env.LIVE_TRADING_ENABLED;
  else process.env.LIVE_TRADING_ENABLED = previous;
});
