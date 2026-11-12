import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import {
  validateItem, validateSellQuantity, validateComment, COMMENT_MAX, normalizeItem, normalizeSale,
  salesByItem, saleMarkup, parseRatePayload, friendlyError,
  BRACKETS, groupByBracket, salesSubtotal, parseISODate, toISODate,
  groupByYearMonth, periodOptions, periodTotals, periodLabel, ALL_TIME, validateBusinessName,
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
  businesses: [],
  businessId: localStorage.getItem("businessId"),
  period: ALL_TIME,          // summary cards: { year, month }
  collapsed: new Set(),      // collapsed group rows, e.g. "sales:2026-11"
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
// Year / month dropdowns for the summary. Options come from the dates that have data.
function renderPeriodControls() {
  const opts = periodOptions(state.items, state.sales);
  let { year, month } = state.period;
  if (year !== "all" && !opts.some((o) => o.year === year)) year = "all";
  const yearOpt = opts.find((o) => o.year === year);
  if (month !== "all" && !yearOpt?.months.some((m) => m.key === month)) month = "all";
  state.period = { year, month };

  const option = (value, text) => el("option", { text, attrs: { value } });
  $("summary-year").replaceChildren(option("all", "All time"), ...opts.map((o) => option(o.year, o.year)));
  $("summary-year").value = year;
  $("summary-month").replaceChildren(
    option("all", "All months"),
    ...(yearOpt?.months ?? []).map((m) => option(m.key, m.label))
  );
  $("summary-month").value = month;
  $("summary-month").disabled = year === "all";
}

function renderStats() {
  renderPeriodControls();
  const p = state.period;
  const all = p.year === "all";
  const label = periodLabel(p);
  const t = periodTotals(state.items, state.sales, p);
  const plural = (n, word) => `${int.format(n)} ${word}${n === 1 ? "" : "s"}`;

  $("summary-caption").textContent = all ? "All time" : `For ${label}`;
  $("stat-products").textContent = int.format(t.products);
  $("stat-products-sub").textContent = all
    ? `${t.outOfStock} out of stock`
    : `acquired in ${label} · ${t.outOfStock} out of stock`;
  $("stat-stock").textContent = int.format(t.unitsInStock);
  $("stat-stock-sub").textContent = all ? "across all products" : `of items acquired in ${label}`;
  $("stat-sold").textContent = int.format(t.unitsSold);
  $("stat-sold-sub").textContent = all ? plural(t.transactions, "transaction") : `${plural(t.transactions, "transaction")} in ${label}`;
  $("stat-revenue").textContent = php.format(t.revenue);
  $("stat-revenue-sub").textContent = all ? "in Philippine peso" : `sold in ${label}`;
}

for (const id of ["summary-year", "summary-month"]) {
  $(id).addEventListener("change", () => {
    const year = $("summary-year").value;
    // Changing the year resets the month.
    const month = id === "summary-year" ? "all" : $("summary-month").value;
    state.period = { year, month };
    renderStats();
  });
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

  const summary = (rows) => {
    const units = rows.reduce((n, i) => n + i.quantity, 0);
    const soldUnits = rows.reduce((n, i) => n + (sold.get(i.id)?.units ?? 0), 0);
    const sales = rows.reduce((n, i) => n + (sold.get(i.id)?.total ?? 0), 0);
    return summaryLine([
      [int.format(rows.length), rows.length === 1 ? "item acquired" : "items acquired"],
      [int.format(units), "in stock"],
      [int.format(soldUnits), "sold"],
      [php.format(sales), "sales"],
    ]);
  };
  // Newest acquisitions first when grouped by date.
  const ordered = state.itemsGroup === "none" ? visible : [...visible].sort(
    (a, b) => b.acquiredOn.localeCompare(a.acquiredOn) || a.name.localeCompare(b.name)
  );
  renderGrouped({
    tbody: $("item-rows"), tableKey: "items", rows: ordered, mode: state.itemsGroup,
    getDate: (i) => parseISODate(i.acquiredOn), rowFn: itemRow, summaryFn: summary, colspan: 10,
    rerender: renderItems,
  });
}

// Renders rows into collapsible period groups, newest first.
// Yearly: each year expands into its months (mm/yyyy), each month into its rows.
function renderGrouped({ tbody, tableKey, rows, mode, getDate, rowFn, summaryFn, colspan, rerender }) {
  if (mode === "none") {
    tbody.replaceChildren(...rows.map(rowFn));
    return;
  }
  const out = [];
  // Adds a group header; returns true if the group is collapsed.
  const header = (g, level) => {
    const id = `${tableKey}:${g.key}`;
    const collapsed = state.collapsed.has(id);
    out.push(groupRow(g.label, summaryFn(g.rows), colspan, { level, collapsed, onToggle: () => {
      state.collapsed.has(id) ? state.collapsed.delete(id) : state.collapsed.add(id);
      rerender();
    } }));
    return collapsed;
  };
  if (mode === "year") {
    for (const year of groupByYearMonth(rows, getDate)) {
      if (header(year, 0)) continue;
      for (const month of year.months) if (!header(month, 1)) out.push(...month.rows.map(rowFn));
    }
  } else {
    for (const g of groupByBracket(rows, getDate, mode)) if (!header(g, 0)) out.push(...g.rows.map(rowFn));
  }
  tbody.replaceChildren(...out);
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

const CHEVRON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

function groupRow(label, summary, colspan, { level = 0, collapsed = false, onToggle }) {
  const toggle = el("button", {
    className: "group-toggle",
    attrs: { type: "button", "aria-expanded": String(!collapsed), "aria-label": `${collapsed ? "Expand" : "Collapse"} ${label}` },
  });
  toggle.innerHTML = CHEVRON; // constant markup
  const row = el("tr", { className: `group-row level-${level}${collapsed ? " collapsed" : ""}` }, [
    el("td", { attrs: { colspan } }, [
      el("div", { className: "group-head" }, [
        el("span", { className: "group-label" }, [toggle, label]),
        summary,
      ]),
    ]),
  ]);
  // Whole header row toggles; the button gives keyboard access.
  row.addEventListener("click", onToggle);
  return row;
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
        el("td", {}, [
          el("div", { className: "item-name", text: s.itemName }),
          ...(s.comment ? [el("div", { className: "sale-comment", text: s.comment, attrs: { title: s.comment } })] : []),
        ]),
        el("td", { className: "num", text: int.format(s.quantity) }),
        el("td", { className: "num", text: php.format(s.unitPrice) }),
        markupCell(s),
        el("td", { className: "num", text: php.format(s.total) }),
        el("td", { className: "actions-cell" }, [
          el("div", { className: "row-actions" }, [btn("Void", "btn-ghost danger", () => voidSale(s))]),
        ]),
      ]);

  const summary = (rows) => {
      const t = salesSubtotal(rows, state.usdToPhp);
      const markup = el("span", {}, [
        el("strong", {
          text: t.markupTotal == null ? "—" : php.format(t.markupTotal),
          className: t.markupTotal == null ? "" : t.markupTotal < 0 ? "markup-neg" : "markup-pos",
        }),
        " markup",
      ]);
      markup.title = "Sum of markup per unit × quantity";
      return summaryLine(
        [
          [int.format(t.count), t.count === 1 ? "sale" : "sales"],
          [int.format(t.units), t.units === 1 ? "unit" : "units"],
          [php.format(t.total), "total"],
        ],
        [markup]
      );
  };
  renderGrouped({
    tbody: $("sale-rows"), tableKey: "sales", rows: state.sales, mode: state.salesGroup,
    getDate: (s) => new Date(s.soldAt), rowFn: saleRow, summaryFn: summary, colspan: 7,
    rerender: renderSales,
  });
}

function render() {
  renderStats();
  renderItems();
  renderSales();
}

// ---------- data ----------
async function loadData() {
  const businessId = state.businessId;
  if (!businessId) {
    state.items = [];
    state.sales = [];
    return;
  }
  const [itemsRes, salesRes] = await Promise.all([
    supabase.from("items").select("*").eq("business_id", businessId).order("name"),
    supabase.from("sales").select("*").eq("business_id", businessId).order("sold_at", { ascending: false }),
  ]);
  if (state.businessId !== businessId) return; // switched business while loading
  const error = itemsRes.error || salesRes.error;
  if (error) {
    toast(`Could not load data: ${friendlyError(error)}`, true);
    return;
  }
  state.items = itemsRes.data.map(normalizeItem);
  state.sales = salesRes.data.map(normalizeSale);
  render();
}

// Businesses (with item/sale counts for the manage dialog).
async function loadBusinesses() {
  const { data, error } = await supabase
    .from("businesses")
    .select("id, name, items(count), sales(count)")
    .order("name");
  if (error) {
    toast(`Could not load businesses: ${friendlyError(error)}`, true);
    return;
  }
  state.businesses = data.map((b) => ({
    id: b.id,
    name: b.name,
    itemCount: b.items?.[0]?.count ?? 0,
    saleCount: b.sales?.[0]?.count ?? 0,
  }));
  if (!state.businesses.some((b) => b.id === state.businessId)) {
    state.businessId = state.businesses[0]?.id ?? null;
  }
  if (state.businessId) localStorage.setItem("businessId", state.businessId);
  else localStorage.removeItem("businessId");
  renderBusinesses();
}

// Reload everything the current view shows.
async function refresh() {
  await loadBusinesses();
  await loadData();
}

// Live updates: reload when anyone changes businesses, items or sales (debounced).
let realtimeChannel = null;
let reloadTimer;
function subscribeRealtime() {
  const reload = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(refresh, 300); };
  realtimeChannel = supabase
    .channel("inventory")
    .on("postgres_changes", { event: "*", schema: "public", table: "businesses" }, reload)
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
  await Promise.all([refresh(), loadRate()]);
  subscribeRealtime();
  rateTimer = setInterval(loadRate, RATE_REFRESH_MS);
}

function onSignedOut() {
  state.user = null;
  state.items = [];
  state.sales = [];
  state.businesses = [];
  state.period = ALL_TIME;
  state.collapsed.clear();
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
      : await supabase.from("items").insert({ ...row, business_id: state.businessId });
    if (dbError) return ($("item-error").textContent = friendlyError(dbError));
    $("item-dialog").close();
    toast(id ? "Item updated" : "Item added");
    await refresh();
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
  await refresh();
}

// Sell
let sellingItem = null;
function updateSellTotal() {
  const qty = Number($("sell-qty").value);
  const total = Number.isFinite(qty) && qty > 0 ? qty * sellingItem.sellingPrice : 0;
  $("sell-total").textContent = php.format(total);
}
$("sell-qty").addEventListener("input", updateSellTotal);

function updateCommentCount() {
  const n = $("sell-comment").value.length;
  $("sell-comment-count").textContent = `${n}/${COMMENT_MAX}`;
  $("sell-comment-count").classList.toggle("near-limit", n > COMMENT_MAX - 50);
}
$("sell-comment").addEventListener("input", updateCommentCount);

function openSell(item) {
  sellingItem = item;
  $("sell-item-name").textContent = item.name;
  $("sell-item-meta").textContent = `${int.format(item.quantity)} in stock · ${php.format(item.sellingPrice)} each`;
  $("sell-qty").value = 1;
  $("sell-qty").max = item.quantity;
  $("sell-comment").value = "";
  updateCommentCount();
  $("sell-error").textContent = "";
  updateSellTotal();
  $("sell-dialog").showModal();
  $("sell-qty").select();
}

$("sell-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const { qty, error } = validateSellQuantity($("sell-qty").value, sellingItem.quantity);
  if (error) return ($("sell-error").textContent = error);
  const { comment, error: commentError } = validateComment($("sell-comment").value);
  if (commentError) return ($("sell-error").textContent = commentError);

  withBusy(e.submitter, async () => {
    const { data: sale, error: dbError } = await supabase.rpc("sell_item", {
      p_item_id: sellingItem.id,
      p_quantity: qty,
      p_usd_to_php: state.usdToPhp, // snapshot for the markup; null if unavailable
      p_comment: comment,
    });
    if (dbError) return ($("sell-error").textContent = friendlyError(dbError));
    $("sell-dialog").close();
    toast(`Sold ${sale.quantity} × ${sale.item_name} for ${php.format(Number(sale.total_php))}`);
    await refresh();
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
  await refresh();
}

// ---------- businesses ----------
const currentBusiness = () => state.businesses.find((b) => b.id === state.businessId);

function renderBusinesses() {
  const has = state.businesses.length > 0;
  $("business-switcher").hidden = !has;
  $("no-business").hidden = has;
  $("business-content").hidden = !has;
  document.title = has ? `${currentBusiness().name} · Inventory Manager` : "Inventory Manager";

  $("business-select").replaceChildren(
    ...state.businesses.map((b) => el("option", { text: b.name, attrs: { value: b.id } }))
  );
  if (has) $("business-select").value = state.businessId;

  const plural = (n, word) => `${int.format(n)} ${word}${n === 1 ? "" : "s"}`;
  $("business-list").replaceChildren(
    ...state.businesses.map((b) =>
      el("li", {}, [
        el("span", { className: "biz-name", text: b.name },
          b.id === state.businessId ? [el("span", { className: "current", text: "Current" })] : []),
        el("span", { className: "biz-meta", text: `${plural(b.itemCount, "item")} · ${plural(b.saleCount, "sale")}` }),
        btn("Rename", "btn-ghost", () => openBusinessForm(b)),
        btn("Delete", "btn-ghost danger", () => openDeleteBusiness(b)),
      ])
    )
  );
}

async function switchBusiness(id) {
  state.businessId = id;
  localStorage.setItem("businessId", id);
  // Each business starts with a fresh view.
  state.period = ALL_TIME;
  state.collapsed.clear();
  state.search = "";
  $("search").value = "";
  state.items = [];
  state.sales = [];
  renderBusinesses();
  render();
  await loadData();
}

$("business-select").addEventListener("change", (e) => switchBusiness(e.target.value));
$("manage-businesses-btn").addEventListener("click", () => $("businesses-dialog").showModal());
$("add-business-btn").addEventListener("click", () => openBusinessForm(null));
$("create-first-business-btn").addEventListener("click", () => openBusinessForm(null));

function openBusinessForm(business) {
  $("business-form").reset();
  $("business-id").value = business?.id ?? "";
  $("business-name").value = business?.name ?? "";
  $("business-form-title").textContent = business ? "Rename business" : "Add business";
  $("business-submit").textContent = business ? "Save" : "Add business";
  $("business-error").textContent = "";
  $("business-form-dialog").showModal();
  $("business-name").focus();
}

$("business-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = $("business-id").value || null;
  const { name, error } = validateBusinessName($("business-name").value, state.businesses, id);
  if (error) return ($("business-error").textContent = error);

  withBusy($("business-submit"), async () => {
    if (id) {
      const { error: dbError } = await supabase.from("businesses").update({ name }).eq("id", id);
      if (dbError) return ($("business-error").textContent = friendlyError(dbError));
      $("business-form-dialog").close();
      toast("Business renamed");
      await loadBusinesses();
    } else {
      const { data, error: dbError } = await supabase.from("businesses").insert({ name }).select("id").single();
      if (dbError) return ($("business-error").textContent = friendlyError(dbError));
      $("business-form-dialog").close();
      $("businesses-dialog").close();
      toast(`Created “${name}”`);
      await loadBusinesses();
      await switchBusiness(data.id); // jump straight into the new business
    }
  });
});

let deletingBusiness = null;
function openDeleteBusiness(business) {
  deletingBusiness = business;
  const plural = (n, word) => `${int.format(n)} ${word}${n === 1 ? "" : "s"}`;
  $("delete-business-message").textContent =
    `This permanently deletes “${business.name}” with its ${plural(business.itemCount, "item")} ` +
    `and ${plural(business.saleCount, "sale")}. This can't be undone.`;
  $("delete-business-name").textContent = business.name;
  $("delete-business-confirm").value = "";
  $("delete-business-submit").disabled = true;
  $("delete-business-error").textContent = "";
  $("delete-business-dialog").showModal();
  $("delete-business-confirm").focus();
}

$("delete-business-confirm").addEventListener("input", (e) => {
  $("delete-business-submit").disabled = e.target.value.trim() !== deletingBusiness.name.trim();
});

$("delete-business-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if ($("delete-business-confirm").value.trim() !== deletingBusiness.name.trim()) return;
  withBusy($("delete-business-submit"), async () => {
    const { error } = await supabase.from("businesses").delete().eq("id", deletingBusiness.id);
    if (error) return ($("delete-business-error").textContent = friendlyError(error));
    $("delete-business-dialog").close();
    toast(`Deleted “${deletingBusiness.name}”`);
    const wasCurrent = deletingBusiness.id === state.businessId;
    await loadBusinesses();
    if (wasCurrent) {
      if (state.businessId) await switchBusiness(state.businessId);
      else $("businesses-dialog").close();
    }
  });
});

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
