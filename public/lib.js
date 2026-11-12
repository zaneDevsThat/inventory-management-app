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

// Validates form input; returns { row } ready to write to the items table, or { error }.
export function validateItem({ name, quantity, acquiredAmount, sellingPrice }) {
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

  return {
    row: { name: cleanName, quantity: qty, acquired_amount_usd: acquired, selling_price_php: selling },
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
