// Pure logic shared by the UI. No DOM or network access, so it can be unit tested in Node.

// Accepts numbers or numeric strings; rejects null, "", booleans, etc. (Number(null) === 0).
export function toNumber(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") return Number(v);
  return NaN;
}

// A currency amount: finite, non-negative, at most 2 decimal places (cents / centavos).
export function isMoney(n) {
  return Number.isFinite(n) && n >= 0 && Math.abs(Math.round(n * 100) - n * 100) < 1e-6;
}

export const round2 = (n) => Math.round(n * 100) / 100;

// ---------- dates ----------
const pad = (n) => String(n).padStart(2, "0");

// Local calendar date as YYYY-MM-DD.
export function toISODate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Parses YYYY-MM-DD as a local calendar date (new Date("2026-11-13") would be UTC midnight).
export function parseISODate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? "");
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return toISODate(d) === s ? d : null; // rejects 2026-02-30 etc.
}

// Validates form input; returns { row } ready to write to the items table, or { error }.
// `today` is injectable for tests.
export function validateItem({ name, quantity, acquiredAmount, sellingPrice, acquiredOn }, today = new Date()) {
  const cleanName = typeof name === "string" ? name.trim() : "";
  if (!cleanName) return { error: "Item name is required" };
  if (cleanName.length > 100) return { error: "Item name must be 100 characters or fewer" };

  const qty = toNumber(quantity);
  if (!Number.isInteger(qty) || qty < 0) return { error: "Quantity must be a whole number of 0 or more" };

  const acquired = toNumber(acquiredAmount);
  if (!isMoney(acquired))
    return { error: "Acquired amount must be a US dollar amount of 0 or more, with at most 2 decimals" };

  const selling = toNumber(sellingPrice);
  if (!isMoney(selling))
    return { error: "Selling price must be a Philippine peso amount of 0 or more, with at most 2 decimals" };

  if (!acquiredOn) return { error: "Date acquired is required" };
  if (!parseISODate(acquiredOn)) return { error: "Date acquired must be a valid date" };
  if (acquiredOn < "2000-01-01") return { error: "Date acquired must be in the year 2000 or later" };
  if (acquiredOn > toISODate(today)) return { error: "Date acquired can't be in the future" };

  return {
    row: {
      name: cleanName,
      quantity: qty,
      acquired_amount_usd: acquired,
      selling_price_php: selling,
      acquired_on: acquiredOn,
    },
  };
}

export function validateSellQuantity(value, inStock) {
  const qty = toNumber(value);
  if (!Number.isInteger(qty) || qty < 1) return { error: "Quantity sold must be a whole number of at least 1" };
  if (qty > inStock) return { error: `Only ${inStock} in stock` };
  return { qty };
}

const num = (v) => (v == null ? null : Number(v));

// Database rows (snake_case, numerics possibly as strings) -> UI objects.
export function normalizeItem(r) {
  return {
    id: r.id,
    name: r.name,
    quantity: Number(r.quantity),
    inStock: Number(r.quantity) > 0,
    acquiredAmount: Number(r.acquired_amount_usd),
    sellingPrice: Number(r.selling_price_php),
    acquiredOn: r.acquired_on, // YYYY-MM-DD
    createdAt: r.created_at,
  };
}

export function normalizeSale(r) {
  return {
    id: r.id,
    itemId: r.item_id,
    itemName: r.item_name,
    quantity: Number(r.quantity),
    unitPrice: Number(r.unit_price_php),
    total: Number(r.total_php),
    acquiredAmountUsd: num(r.acquired_amount_usd),
    usdToPhp: num(r.usd_to_php),
    markup: num(r.markup_php),
    soldAt: r.sold_at,
  };
}

// Units sold and sales sum per item id.
export function salesByItem(sales) {
  const map = new Map();
  for (const s of sales) {
    if (!s.itemId) continue;
    const agg = map.get(s.itemId) || { units: 0, total: 0 };
    agg.units += s.quantity;
    agg.total = round2(agg.total + s.total);
    map.set(s.itemId, agg);
  }
  return map;
}

export function totals(items, sales) {
  return {
    products: items.length,
    outOfStock: items.filter((i) => !i.inStock).length,
    unitsInStock: items.reduce((n, i) => n + i.quantity, 0),
    unitsSold: sales.reduce((n, s) => n + s.quantity, 0),
    transactions: sales.length,
    revenue: round2(sales.reduce((n, s) => n + s.total, 0)),
  };
}

// Markup per unit = selling price - acquired amount converted to PHP.
// Uses the rate saved with the sale; falls back to the current rate if none was saved.
// Returns null when it can't be computed.
export function saleMarkup(sale, currentRate) {
  const rate = sale.usdToPhp ?? currentRate;
  if (sale.acquiredAmountUsd == null || rate == null) return null;
  const costPhp = sale.acquiredAmountUsd * rate;
  return {
    markup: sale.markup ?? round2(sale.unitPrice - costPhp),
    costPhp,
    rate,
    usedCurrentRate: sale.usdToPhp == null,
  };
}

// Validates the exchange-rate provider's payload; returns { rate, updatedAt } or throws.
export function parseRatePayload(data) {
  const rate = data?.rates?.PHP;
  if (data?.result !== "success" || !Number.isFinite(rate) || rate <= 0) {
    throw new Error("Rate provider sent no valid PHP rate");
  }
  return { rate, updatedAt: data.time_last_update_utc ?? null };
}

// Turns database/auth errors into messages a user can act on.
export function friendlyError(err) {
  const msg = err?.message || String(err);
  if (/Invalid login credentials/i.test(msg)) return "Incorrect email or password.";
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return "Can't reach the server. Check your internet connection.";
  if (/JWT expired|not signed in/i.test(msg)) return "Your session expired. Please sign in again.";
  if (/items_name_check/.test(msg)) return "Item name is required (max 100 characters).";
  if (/items_quantity_check/.test(msg)) return "Quantity must be 0 or more.";
  if (/check constraint/.test(msg)) return "Amounts must be 0 or more.";
  return msg;
}

// ---------- weekly / monthly / yearly brackets ----------
export const BRACKETS = ["none", "week", "month", "year"];

const monthDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const monthYear = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" });

// The bracket a local date falls in. Weeks run Monday–Sunday.
// `key` sorts chronologically as a string.
export function bracketOf(date, mode) {
  const y = date.getFullYear();
  if (mode === "year") return { key: String(y), label: String(y) };
  if (mode === "month") {
    return { key: `${y}-${pad(date.getMonth() + 1)}`, label: monthYear.format(date) };
  }
  if (mode === "week") {
    const start = new Date(y, date.getMonth(), date.getDate() - ((date.getDay() + 6) % 7));
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
    const label =
      start.getFullYear() === end.getFullYear()
        ? `${monthDay.format(start)} – ${monthDay.format(end)}, ${end.getFullYear()}`
        : `${monthDay.format(start)}, ${start.getFullYear()} – ${monthDay.format(end)}, ${end.getFullYear()}`;
    return { key: toISODate(start), label: `Week of ${label}` };
  }
  throw new Error(`Unknown bracket: ${mode}`);
}

// Groups rows into brackets, newest bracket first. Row order within a bracket is preserved.
export function groupByBracket(rows, getDate, mode) {
  const groups = new Map();
  for (const row of rows) {
    const { key, label } = bracketOf(getDate(row), mode);
    if (!groups.has(key)) groups.set(key, { key, label, rows: [] });
    groups.get(key).rows.push(row);
  }
  return [...groups.values()].sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
}

// Subtotals for a bracket of sales. Markup total = sum of (markup per unit x quantity)
// over sales where it's known.
export function salesSubtotal(sales, currentRate) {
  let units = 0, total = 0, markupTotal = 0, markupKnown = 0;
  for (const s of sales) {
    units += s.quantity;
    total += s.total;
    const m = saleMarkup(s, currentRate);
    if (m) { markupTotal += m.markup * s.quantity; markupKnown++; }
  }
  return {
    count: sales.length,
    units,
    total: round2(total),
    markupTotal: markupKnown ? round2(markupTotal) : null,
  };
}
