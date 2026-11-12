import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toNumber, isMoney, validateItem, validateSellQuantity, normalizeItem, normalizeSale,
  salesByItem, totals, saleMarkup, parseRatePayload, friendlyError,
} from "../public/lib.js";

test("toNumber rejects null/empty/booleans", () => {
  assert.equal(toNumber("12.5"), 12.5);
  assert.equal(toNumber(3), 3);
  for (const v of [null, undefined, "", "  ", true]) assert.ok(Number.isNaN(toNumber(v)), String(v));
});

test("isMoney allows at most 2 decimals", () => {
  for (const v of [0, 1, 10.5, 99.99, 1234567.89]) assert.ok(isMoney(v), String(v));
  for (const v of [-1, 1.234, NaN, Infinity]) assert.ok(!isMoney(v), String(v));
});

test("validateItem builds a DB row from form strings", () => {
  const { row, error } = validateItem({ name: "  Pen ", quantity: "3", acquiredAmount: "2.50", sellingPrice: "200" });
  assert.equal(error, undefined);
  assert.deepEqual(row, { name: "Pen", quantity: 3, acquired_amount_usd: 2.5, selling_price_php: 200 });
});

test("validateItem rejects bad input", () => {
  const ok = { name: "X", quantity: "1", acquiredAmount: "1", sellingPrice: "1" };
  const bad = [
    [{ name: " " }, /name/i],
    [{ name: "x".repeat(101) }, /100/],
    [{ quantity: "-1" }, /Quantity/],
    [{ quantity: "1.5" }, /Quantity/],
    [{ quantity: "" }, /Quantity/],
    [{ acquiredAmount: "-2" }, /US dollar/],
    [{ acquiredAmount: "" }, /US dollar/],
    [{ sellingPrice: "10.555" }, /peso/],
  ];
  for (const [patch, re] of bad) assert.match(validateItem({ ...ok, ...patch }).error, re, JSON.stringify(patch));
});

test("validateSellQuantity", () => {
  assert.deepEqual(validateSellQuantity("2", 5), { qty: 2 });
  assert.match(validateSellQuantity("6", 5).error, /Only 5 in stock/);
  for (const v of ["0", "-1", "1.5", ""]) assert.match(validateSellQuantity(v, 5).error, /at least 1/);
});

test("normalize converts DB numerics (which may be strings)", () => {
  const item = normalizeItem({ id: "a", name: "Pen", quantity: 0, acquired_amount_usd: "2.44", selling_price_php: "700.00" });
  assert.deepEqual([item.acquiredAmount, item.sellingPrice, item.inStock], [2.44, 700, false]);
  const sale = normalizeSale({ id: "s", item_id: null, item_name: "Pen", quantity: 1, unit_price_php: "700", total_php: "700",
    acquired_amount_usd: "2.44", usd_to_php: null, markup_php: null, sold_at: "2026-11-13T00:00:00Z" });
  assert.equal(sale.usdToPhp, null);
  assert.equal(sale.acquiredAmountUsd, 2.44);
});

test("salesByItem and totals", () => {
  const items = [{ id: "a", quantity: 2, inStock: true }, { id: "b", quantity: 0, inStock: false }];
  const sales = [
    { itemId: "a", quantity: 2, total: 0.1 },
    { itemId: "a", quantity: 1, total: 0.2 },
    { itemId: null, quantity: 4, total: 100 }, // deleted item: counts in totals only
  ];
  assert.deepEqual(salesByItem(sales).get("a"), { units: 3, total: 0.3 }); // no float drift
  assert.deepEqual(totals(items, sales), {
    products: 2, outOfStock: 1, unitsInStock: 2, unitsSold: 7, transactions: 3, revenue: 100.3,
  });
});

test("saleMarkup = selling price - acquired amount in PHP", () => {
  const sale = { unitPrice: 700, acquiredAmountUsd: 2.44, usdToPhp: 63.30539, markup: 545.53 };
  const m = saleMarkup(sale, 99);
  assert.equal(m.markup, 545.53);
  assert.equal(m.rate, 63.30539, "uses rate saved with the sale, not current");
  assert.equal(m.usedCurrentRate, false);
});

test("saleMarkup falls back to current rate, or null", () => {
  const sale = { unitPrice: 100, acquiredAmountUsd: 2, usdToPhp: null, markup: null };
  const m = saleMarkup(sale, 60);
  assert.equal(m.markup, -20);
  assert.equal(m.usedCurrentRate, true);
  assert.equal(saleMarkup(sale, null), null);
  assert.equal(saleMarkup({ ...sale, acquiredAmountUsd: null }, 60), null);
});

test("parseRatePayload", () => {
  assert.deepEqual(parseRatePayload({ result: "success", rates: { PHP: 58.1 }, time_last_update_utc: "t" }), { rate: 58.1, updatedAt: "t" });
  for (const bad of [null, {}, { result: "error" }, { result: "success", rates: { PHP: 0 } }, { result: "success", rates: {} }])
    assert.throws(() => parseRatePayload(bad));
});

test("friendlyError", () => {
  assert.match(friendlyError({ message: "Invalid login credentials" }), /Incorrect email or password/);
  assert.match(friendlyError(new TypeError("Failed to fetch")), /internet/);
  assert.equal(friendlyError({ message: "Only 2 in stock" }), "Only 2 in stock");
});
