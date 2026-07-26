import assert from "node:assert/strict";
import test from "node:test";
import { formatHypercoreNumber, hypercoreRequiredCapitalUsd, minimumHypercoreTickNotionalUsd, roundHypercoreOpenSize, roundHypercorePrice, roundHypercoreSize } from "../src/lib/execution/hypercore-execution-math.ts";

test("HyperCore emir miktarı size decimals sınırında aşağı yuvarlanır", () => {
  assert.equal(roundHypercoreSize(1.234567, 3), 1.234);
  assert.equal(roundHypercoreSize(0.0003, 4), 0.0003);
});

test("HyperCore alış fiyatı yukarı, satış fiyatı aşağı yuvarlanır", () => {
  assert.ok(roundHypercorePrice(123.4567, 2, "perp", "buy") >= Number((123.4567).toPrecision(5)));
  assert.ok(roundHypercorePrice(123.4567, 2, "perp", "sell") <= Number((123.4567).toPrecision(5)));
});

test("HyperCore sayıları gereksiz sıfır olmadan gönderilir", () => {
  assert.equal(formatHypercoreNumber(12.34, 5), "12.34");
});

test("HyperCore shadow riski kaldıraçlı notional yerine teminat ve ücreti kullanır", () => {
  assert.equal(hypercoreRequiredCapitalUsd(9, 3, 0.00035), 3.00315);
});

test("HyperCore açılış miktarı tick sonrasında minimum notional değerini korur", () => {
  const size = roundHypercoreOpenSize({ quantity: 0.0999, sizeDecimals: 3, priceUsd: 100, minimumNotionalUsd: 10, maximumNotionalUsd: 12, availableNotionalUsd: 20 });
  assert.equal(size, 0.1);
  assert.ok(size * 100 >= 10);
});

test("HyperCore minimum emri kullanılabilir tavanı aşamaz", () => {
  assert.throws(() => roundHypercoreOpenSize({ quantity: 0.09, sizeDecimals: 1, priceUsd: 101, minimumNotionalUsd: 10, maximumNotionalUsd: 10, availableNotionalUsd: 10 }), /kullanılabilir bakiye/);
});

test("yüksek fiyatlı HyperCore piyasasında minimum geçerli tick notional hesaplanır", () => {
  assert.ok(Math.abs(minimumHypercoreTickNotionalUsd(7_496.3, 3, 10.5) - 14.9926) < 1e-9);
});

test("SP500 minimum tick emri mevcut HyperCore bakiyesine sığar", () => {
  const priceUsd = 7_472.2;
  const minimumNotionalUsd = minimumHypercoreTickNotionalUsd(priceUsd, 3, 10.5);
  const size = roundHypercoreOpenSize({
    quantity: 12 / priceUsd,
    sizeDecimals: 3,
    priceUsd,
    minimumNotionalUsd: 10.5,
    maximumNotionalUsd: minimumNotionalUsd,
    availableNotionalUsd: 20.26283898,
  });
  assert.equal(size, 0.002);
  assert.ok(size * priceUsd <= 20.26283898);
});
