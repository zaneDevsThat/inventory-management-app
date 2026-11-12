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
  const { row, error } = validateItem(
    { name: "  Pen ", quantity: "3", acquiredAmount: "2.50", sellingPrice: "200", acquiredOn: "2026-11-01" },
    new Date(2026, 10, 13)
  );
  assert.equal(error, undefined);
  assert.deepEqual(row, { name: "Pen", quantity: 3, acquired_amount_usd: 2.5, selling_price_php: 200, acquired_on: "2026-11-01" });
});

test("validateItem rejects bad input", () => {
  const ok = { name: "X", quantity: "1", acquiredAmount: "1", sellingPrice: "1", acquiredOn: "2026-01-01" };
  assert.ok(validateItem(ok).row, "baseline is valid");
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

import { toISODate, parseISODate, bracketOf, groupByBracket, salesSubtotal } from "../public/lib.js";

test("parseISODate is local and strict", () => {
  const d = parseISODate("2026-11-13");
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate()], [2026, 10, 13]);
  for (const bad of ["2026-02-30", "2026-13-01", "13/11/2026", "", null]) assert.equal(parseISODate(bad), null, String(bad));
  assert.equal(toISODate(new Date(2026, 0, 5)), "2026-01-05");
});

test("validateItem checks date acquired", () => {
  const base = { name: "X", quantity: "1", acquiredAmount: "1", sellingPrice: "1" };
  const today = new Date(2026, 10, 13);
  assert.equal(validateItem({ ...base, acquiredOn: "2026-11-13" }, today).row.acquired_on, "2026-11-13");
  assert.match(validateItem({ ...base, acquiredOn: "" }, today).error, /required/);
  assert.match(validateItem({ ...base, acquiredOn: "2026-11-14" }, today).error, /future/);
  assert.match(validateItem({ ...base, acquiredOn: "1999-12-31" }, today).error, /2000/);
  assert.match(validateItem({ ...base, acquiredOn: "2026-02-30" }, today).error, /valid/);
});

test("bracketOf: weeks start Monday", () => {
  // Fri 13 Nov 2026 -> week Mon 9 – Sun 15
  assert.deepEqual(bracketOf(new Date(2026, 10, 13), "week"), { key: "2026-11-09", label: "Week of Nov 9 – Nov 15, 2026" });
  // Sunday belongs to the week that started the previous Monday
  assert.equal(bracketOf(new Date(2026, 10, 15), "week").key, "2026-11-09");
  assert.equal(bracketOf(new Date(2026, 10, 16), "week").key, "2026-11-16");
  // Week spanning a year boundary
  assert.deepEqual(bracketOf(new Date(2027, 0, 1), "week"), { key: "2026-12-28", label: "Week of Dec 28, 2026 – Jan 3, 2027" });
  assert.deepEqual(bracketOf(new Date(2026, 10, 13), "month"), { key: "2026-11", label: "November 2026" });
  assert.deepEqual(bracketOf(new Date(2026, 10, 13), "year"), { key: "2026", label: "2026" });
});

test("groupByBracket sorts brackets newest first, keeps row order", () => {
  const rows = [
    { n: "a", d: new Date(2026, 0, 5) },
    { n: "b", d: new Date(2026, 10, 2) },
    { n: "c", d: new Date(2026, 0, 20) },
    { n: "d", d: new Date(2025, 11, 31) },
  ];
  const g = groupByBracket(rows, (r) => r.d, "month");
  assert.deepEqual(g.map((x) => x.key), ["2026-11", "2026-01", "2025-12"]);
  assert.deepEqual(g[1].rows.map((r) => r.n), ["a", "c"]);
  assert.deepEqual(groupByBracket(rows, (r) => r.d, "year").map((x) => [x.key, x.rows.length]), [["2026", 3], ["2025", 1]]);
});

test("salesSubtotal sums units, totals and markup x qty", () => {
  const sales = [
    { quantity: 3, total: 2100, unitPrice: 700, acquiredAmountUsd: 2.44, usdToPhp: 63.30539, markup: 545.53 },
    { quantity: 1, total: 199, unitPrice: 199, acquiredAmountUsd: 4, usdToPhp: 63.30539, markup: -54.22 },
  ];
  assert.deepEqual(salesSubtotal(sales, null), { count: 2, units: 4, total: 2299, markupTotal: 1582.37 });
  assert.equal(salesSubtotal([{ quantity: 1, total: 5, unitPrice: 5, acquiredAmountUsd: null, usdToPhp: null, markup: null }], null).markupTotal, null);
});
