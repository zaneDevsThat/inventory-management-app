import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import {
  validateItem, validateSellQuantity, normalizeItem, normalizeSale,
  salesByItem, totals, saleMarkup, parseRatePayload, friendlyError,
  BRACKETS, groupByBracket, salesSubtotal, parseISODate, toISODate,
} from "./lib.js";

const $ = (id) => document.getElementById(id);
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const php = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });
const int = new Intl.NumberFormat("en-US");
const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const dayFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

const RATE_URL = "https://open.er-api.com/v6/latest/USD";
const RATE_CACHE_KEY = "usdToPhpRate";
const RATE_TTL_MS = 60 * 60 * 1000;       // provider updates daily; don't hammer it
const RATE_REFRESH_MS = 30 * 60 * 1000;

const savedBracket = (key) => (BRACKETS.includes(localStorage.getItem(key)) ? localStorage.getItem(key) : "none");
const state = {
  items: [], sales: [], usdToPhp: null, search: "", user: null,
  itemsGroup: savedBracket("itemsGroup"),
  salesGroup: savedBracket("salesGroup"),
};

// ---------- theme (works on every screen) ----------
$("theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("theme", next);
});

// ---------- helpers ----------
function el(tag, { className, text, attrs } = {}, children = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

function btn(label, className, onClick, disabled = false) {
  const b = el("button", { className: `btn btn-sm ${className}`, text: label, attrs: { type: "button" } });
  b.disabled = disabled;
  b.addEventListener("click", onClick);
  return b;
}

let toastTimer;
function toast(message, isError = false) {
  const t = $("toast");
  t.textContent = message;
  t.classList.toggle("error", isError);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3000);
}

const toPhp = (amountUsd) => (state.usdToPhp == null ? "—" : php.format(amountUsd * state.usdToPhp));

// Prevents double submits while a request is in flight.
async function withBusy(button, fn) {
  button.disabled = true;
  try { return await fn(); } finally { button.disabled = false; }
}

function showScreen(name) {
  $("setup-screen").hidden = name !== "setup";
  $("login-screen").hidden = name !== "login";
  $("app").hidden = name !== "app";
}

// ---------- setup check ----------
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  showScreen("setup");
  throw new Error("Supabase is not configured (public/config.js)");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------- rendering ----------
function renderStats() {
  const t = totals(state.items, state.sales);
  $("stat-products").textContent = int.format(t.products);
  $("stat-products-sub").textContent = `${t.outOfStock} out of stock`;
  $("stat-stock").textContent = int.format(t.unitsInStock);
  $("stat-sold").textContent = int.format(t.unitsSold);
  $("stat-sold-sub").textContent = `${t.transactions} transaction${t.transactions === 1 ? "" : "s"}`;
  $("stat-revenue").textContent = php.format(t.revenue);
}

function renderItems() {
  const q = state.search.trim().toLowerCase();
  const visible = q ? state.items.filter((i) => i.name.toLowerCase().includes(q)) : state.items;
  const sold = salesByItem(state.sales);

  $("items-empty").hidden = state.items.length > 0;
  $("items-nomatch").hidden = !(state.items.length > 0 && visible.length === 0);

  const itemRow = (item) => {
      const s = sold.get(item.id) || { units: 0, total: 0 };
      const badge = el("span", {
        className: `badge ${item.inStock ? "in" : "out"}`,
        text: item.inStock ? "In stock" : "Out of stock",
      });
      const actions = el("div", { className: "row-actions" }, [
        btn("Sell", "btn-ghost success", () => openSell(item), !item.inStock),
        btn("Edit", "btn-ghost", () => openItemDialog(item)),
        btn("Delete", "btn-ghost danger", () => deleteItem(item)),
      ]);
      return el("tr", { className: item.inStock ? "" : "out-of-stock" }, [
        el("td", { className: "item-name", text: item.name }),
        el("td", { className: "nowrap", text: item.acquiredOn ? dayFmt.format(parseISODate(item.acquiredOn)) : "—" }),
        el("td", {}, [badge]),
        el("td", { className: "num", text: int.format(item.quantity) }),
        el("td", { className: "num", text: usd.format(item.acquiredAmount) }),
        el("td", { className: "num converted", text: toPhp(item.acquiredAmount) }),
        el("td", { className: "num", text: php.format(item.sellingPrice) }),
        el("td", { className: "num", text: int.format(s.units) }),
        el("td", { className: "num", text: php.format(s.total) }),
        el("td", { className: "actions-cell" }, [actions]),
      ]);
  };

  if (state.itemsGroup === "none") {
    $("item-rows").replaceChildren(...visible.map(itemRow));
    return;
  }
  // Newest acquisitions first within each bracket.
  const ordered = [...visible].sort(
    (a, b) => b.acquiredOn.localeCompare(a.acquiredOn) || a.name.localeCompare(b.name)
  );
  const groups = groupByBracket(ordered, (i) => parseISODate(i.acquiredOn), state.itemsGroup);
  $("item-rows").replaceChildren(
    ...groups.flatMap((g) => {
      const units = g.rows.reduce((n, i) => n + i.quantity, 0);
      const soldUnits = g.rows.reduce((n, i) => n + (sold.get(i.id)?.units ?? 0), 0);
      const sales = g.rows.reduce((n, i) => n + (sold.get(i.id)?.total ?? 0), 0);
      const summary = summaryLine([
        [int.format(g.rows.length), g.rows.length === 1 ? "item acquired" : "items acquired"],
        [int.format(units), "in stock"],
        [int.format(soldUnits), "sold"],
        [php.format(sales), "sales"],
      ]);
      return [groupRow(g.label, summary, 10), ...g.rows.map(itemRow)];
    })
  );
}

// "<strong>3</strong> items · <strong>₱1.00</strong> sales" built safely from parts.
function summaryLine(parts, extra = []) {
  const span = el("span", { className: "group-summary" });
  parts.forEach(([value, label], i) => {
    if (i) span.append(" · ");
    span.append(el("strong", { text: value }), ` ${label}`);
  });
  for (const node of extra) span.append(" · ", node);
  return span;
}

function groupRow(label, summary, colspan) {
  return el("tr", { className: "group-row" }, [
    el("td", { attrs: { colspan } }, [
      el("div", { className: "group-head" }, [el("span", { className: "group-label", text: label }), summary]),
    ]),
  ]);
}

function markupCell(sale) {
  const td = el("td", { className: "num" });
  const m = saleMarkup(sale, state.usdToPhp);
  if (!m) {
    td.textContent = "—";
    td.title = "Not available: the cost or exchange rate wasn't recorded for this sale";
    return td;
  }
  td.textContent = php.format(m.markup);
  td.classList.add(m.markup < 0 ? "markup-neg" : "markup-pos");
  td.title =
    `${php.format(sale.unitPrice)} − ${php.format(m.costPhp)} ` +
    `(${usd.format(sale.acquiredAmountUsd)} × ${m.rate.toFixed(4)}${m.usedCurrentRate ? ", current rate" : ""})`;
  return td;
}

function renderSales() {
  $("sales-empty").hidden = state.sales.length > 0;
  const saleRow = (s) =>
      el("tr", {}, [
        el("td", { text: dateFmt.format(new Date(s.soldAt)) }),
        el("td", { className: "item-name", text: s.itemName }),
        el("td", { className: "num", text: int.format(s.quantity) }),
        el("td", { className: "num", text: php.format(s.unitPrice) }),
        markupCell(s),
        el("td", { className: "num", text: php.format(s.total) }),
        el("td", { className: "actions-cell" }, [
          el("div", { className: "row-actions" }, [btn("Void", "btn-ghost danger", () => voidSale(s))]),
        ]),
      ]);

  if (state.salesGroup === "none") {
    $("sale-rows").replaceChildren(...state.sales.map(saleRow));
    return;
  }
  const groups = groupByBracket(state.sales, (s) => new Date(s.soldAt), state.salesGroup);
  $("sale-rows").replaceChildren(
    ...groups.flatMap((g) => {
      const t = salesSubtotal(g.rows, state.usdToPhp);
      const markup = el("span", {}, [
        el("strong", {
          text: t.markupTotal == null ? "—" : php.format(t.markupTotal),
          className: t.markupTotal == null ? "" : t.markupTotal < 0 ? "markup-neg" : "markup-pos",
        }),
        " markup",
      ]);
      markup.title = "Sum of markup per unit × quantity";
      const summary = summaryLine(
        [
          [int.format(t.count), t.count === 1 ? "sale" : "sales"],
          [int.format(t.units), t.units === 1 ? "unit" : "units"],
          [php.format(t.total), "total"],
        ],
        [markup]
      );
      return [groupRow(g.label, summary, 7), ...g.rows.map(saleRow)];
    })
  );
}

function render() {
  renderStats();
  renderItems();
  renderSales();
}

// ---------- data ----------
async function loadData() {
  const [itemsRes, salesRes] = await Promise.all([
    supabase.from("items").select("*").order("name"),
    supabase.from("sales").select("*").order("sold_at", { ascending: false }),
  ]);
  const error = itemsRes.error || salesRes.error;
  if (error) {
    toast(`Could not load data: ${friendlyError(error)}`, true);
    return;
  }
  state.items = itemsRes.data.map(normalizeItem);
  state.sales = salesRes.data.map(normalizeSale);
  render();
}

// Live updates: reload when anyone changes items or sales (debounced).
let realtimeChannel = null;
let reloadTimer;
function subscribeRealtime() {
  const reload = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(loadData, 300); };
  realtimeChannel = supabase
    .channel("inventory")
    .on("postgres_changes", { event: "*", schema: "public", table: "items" }, reload)
    .on("postgres_changes", { event: "*", schema: "public", table: "sales" }, reload)
    .subscribe();
}

// ---------- exchange rate ----------
function readCachedRate() {
  try { return JSON.parse(localStorage.getItem(RATE_CACHE_KEY)); } catch { return null; }
}

function showRate({ rate, updatedAt }, stale) {
  state.usdToPhp = rate;
  const pill = $("rate-pill");
  const when = updatedAt ? dateFmt.format(new Date(updatedAt)) : "unknown";
  pill.textContent = `1 USD = ${php.format(rate)}${stale ? " (stale)" : ""}`;
  pill.title = `Rate as of ${when}${stale ? " — provider unreachable, using last known rate" : ""}`;
  pill.classList.toggle("warn", stale);
}

async function loadRate() {
  const cached = readCachedRate();
  if (cached && Date.now() - cached.fetchedAt < RATE_TTL_MS) {
    showRate(cached, false);
  } else {
    try {
      const res = await fetch(RATE_URL, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`Rate provider returned ${res.status}`);
      const fresh = { ...parseRatePayload(await res.json()), fetchedAt: Date.now() };
      localStorage.setItem(RATE_CACHE_KEY, JSON.stringify(fresh));
      showRate(fresh, false);
    } catch (err) {
      if (cached) showRate(cached, true);
      else {
        state.usdToPhp = null;
        $("rate-pill").textContent = "Rate unavailable";
        $("rate-pill").title = err.message;
        $("rate-pill").classList.add("warn");
      }
    }
  }
  updatePreview();
  renderItems();
  renderSales();
}

// ---------- auth ----------
let rateTimer = null;
async function onSignedIn(user) {
  if (state.user?.id === user.id) return; // already set up (e.g. token refresh)
  state.user = user;
  $("user-email").textContent = user.email;
  $("password-username").value = user.email;
  showScreen("app");
  await Promise.all([loadData(), loadRate()]);
  subscribeRealtime();
  rateTimer = setInterval(loadRate, RATE_REFRESH_MS);
}

function onSignedOut() {
  state.user = null;
  state.items = [];
  state.sales = [];
  if (realtimeChannel) supabase.removeChannel(realtimeChannel);
  realtimeChannel = null;
  clearInterval(rateTimer);
  document.querySelectorAll("dialog[open]").forEach((d) => d.close());
  $("login-form").reset();
  showScreen("login");
}

supabase.auth.onAuthStateChange((event, session) => {
  // Defer: calling Supabase inside this callback can deadlock the auth client.
  setTimeout(() => (session?.user ? onSignedIn(session.user) : onSignedOut()), 0);
});

$("login-form").addEventListener("submit", (e) => {
  e.preventDefault();
  $("login-error").textContent = "";
  withBusy($("login-submit"), async () => {
    const { error } = await supabase.auth.signInWithPassword({
      email: $("login-email").value.trim(),
      password: $("login-password").value,
    });
    if (error) $("login-error").textContent = friendlyError(error);
  });
});

$("sign-out-btn").addEventListener("click", async () => {
  $("user-menu").open = false;
  await supabase.auth.signOut();
});

// Close the account menu when clicking elsewhere.
document.addEventListener("click", (e) => {
  if (!$("user-menu").contains(e.target)) $("user-menu").open = false;
});

$("change-password-btn").addEventListener("click", () => {
  $("user-menu").open = false;
  $("password-form").reset();
  $("password-error").textContent = "";
  $("password-dialog").showModal();
});

$("password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pw = $("new-password").value;
  if (pw.length < 8) return ($("password-error").textContent = "Password must be at least 8 characters.");
  if (pw !== $("confirm-password").value) return ($("password-error").textContent = "Passwords don't match.");
  await withBusy(e.submitter, async () => {
    const { error } = await supabase.auth.updateUser({ password: pw });
    if (error) return ($("password-error").textContent = friendlyError(error));
    $("password-dialog").close();
    toast("Password updated");
  });
});

// ---------- dialogs ----------
document.querySelectorAll("[data-close]").forEach((b) =>
  b.addEventListener("click", () => b.closest("dialog").close())
);

function confirmDialog({ title, message, okLabel = "Delete" }) {
  const d = $("confirm-dialog");
  $("confirm-title").textContent = title;
  $("confirm-message").textContent = message;
  $("confirm-ok").textContent = okLabel;
  d.returnValue = "";
  d.showModal();
  return new Promise((resolve) =>
    d.addEventListener("close", () => resolve(d.returnValue === "ok"), { once: true })
  );
}

// Add / edit item
function updatePreview() {
  const v = $("acquiredAmount").value;
  $("acquired-php-preview").textContent = v === "" ? "≈ ₱—" : `≈ ${toPhp(Number(v))}`;
}
$("acquiredAmount").addEventListener("input", updatePreview);

function openItemDialog(item) {
  $("item-form").reset();
  $("item-id").value = item?.id ?? "";
  if (item) {
    $("name").value = item.name;
    $("quantity").value = item.quantity;
    $("acquiredAmount").value = item.acquiredAmount;
    $("sellingPrice").value = item.sellingPrice;
  }
  const today = toISODate(new Date());
  $("acquiredOn").max = today;
  $("acquiredOn").value = item?.acquiredOn ?? today;
  $("item-dialog-title").textContent = item ? "Edit item" : "Add item";
  $("item-submit").textContent = item ? "Save changes" : "Add item";
  $("item-error").textContent = "";
  updatePreview();
  $("item-dialog").showModal();
  $("name").focus();
}
$("add-btn").addEventListener("click", () => openItemDialog(null));

$("item-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = $("item-id").value;
  const { row, error } = validateItem({
    name: $("name").value,
    quantity: $("quantity").value,
    acquiredAmount: $("acquiredAmount").value,
    sellingPrice: $("sellingPrice").value,
    acquiredOn: $("acquiredOn").value,
  });
  if (error) return ($("item-error").textContent = error);

  withBusy($("item-submit"), async () => {
    const { error: dbError } = id
      ? await supabase.from("items").update(row).eq("id", id)
      : await supabase.from("items").insert(row);
    if (dbError) return ($("item-error").textContent = friendlyError(dbError));
    $("item-dialog").close();
    toast(id ? "Item updated" : "Item added");
    await loadData();
  });
});

async function deleteItem(item) {
  const ok = await confirmDialog({
    title: "Delete item?",
    message: `“${item.name}” will be removed from inventory. Its past sales stay in the sales history.`,
  });
  if (!ok) return;
  const { error } = await supabase.from("items").delete().eq("id", item.id);
  if (error) return toast(friendlyError(error), true);
  toast("Item deleted");
  await loadData();
}

// Sell
let sellingItem = null;
function updateSellTotal() {
  const qty = Number($("sell-qty").value);
  const total = Number.isFinite(qty) && qty > 0 ? qty * sellingItem.sellingPrice : 0;
  $("sell-total").textContent = php.format(total);
}
$("sell-qty").addEventListener("input", updateSellTotal);

function openSell(item) {
  sellingItem = item;
  $("sell-item-name").textContent = item.name;
  $("sell-item-meta").textContent = `${int.format(item.quantity)} in stock · ${php.format(item.sellingPrice)} each`;
  $("sell-qty").value = 1;
  $("sell-qty").max = item.quantity;
  $("sell-error").textContent = "";
  updateSellTotal();
  $("sell-dialog").showModal();
  $("sell-qty").select();
}

$("sell-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const { qty, error } = validateSellQuantity($("sell-qty").value, sellingItem.quantity);
  if (error) return ($("sell-error").textContent = error);

  withBusy(e.submitter, async () => {
    const { data: sale, error: dbError } = await supabase.rpc("sell_item", {
      p_item_id: sellingItem.id,
      p_quantity: qty,
      p_usd_to_php: state.usdToPhp, // snapshot for the markup; null if unavailable
    });
    if (dbError) return ($("sell-error").textContent = friendlyError(dbError));
    $("sell-dialog").close();
    toast(`Sold ${sale.quantity} × ${sale.item_name} for ${php.format(Number(sale.total_php))}`);
    await loadData();
  });
});

async function voidSale(sale) {
  const ok = await confirmDialog({
    title: "Void sale?",
    message: `This removes the sale of ${sale.quantity} × “${sale.itemName}” (${php.format(sale.total)}) and returns the units to stock.`,
    okLabel: "Void sale",
  });
  if (!ok) return;
  const { error } = await supabase.rpc("void_sale", { p_sale_id: sale.id });
  if (error) return toast(friendlyError(error), true);
  toast("Sale voided");
  await loadData();
}

// ---------- weekly / monthly / yearly grouping ----------
for (const [selectId, key, render] of [
  ["items-group", "itemsGroup", () => renderItems()],
  ["sales-group", "salesGroup", () => renderSales()],
]) {
  $(selectId).value = state[key];
  $(selectId).addEventListener("change", (e) => {
    state[key] = e.target.value;
    localStorage.setItem(key, state[key]);
    render();
  });
}

// ---------- search ----------
$("search").addEventListener("input", (e) => {
  state.search = e.target.value;
  renderItems();
});
