import express from "express";
import fetch from "node-fetch";
const app = express();
app.use(express.json());
// === HEALTH ===
app.get('/ping', (req, res) => res.send('OK'));
app.get('/healthz', (req, res) => res.send('OK'));
// ─── CONFIG ─────────────────────────────────────
const LIVE_MODE = process.env.LIVE_MODE === "true";
const MAX_CONTRACTS = 5;            // hard ceiling per trade
const MIN_CONTRACTS = 1;            // must afford at least 1 or skip
const BP_BUFFER_PCT = 0.02;         // leave 2% headroom so a small fill drift doesn't reject
const PROFIT_PCT = 0.08;
const TIME_STOP_MIN = 30;
const SELL_POLL_INTERVAL_MS = 10000;
const BASE_URL = LIVE_MODE
  ? "https://api.tradier.com/v1"
  : "https://sandbox.tradier.com/v1";
const API_TOKEN = LIVE_MODE
  ? process.env.TRADIER_LIVE_TOKEN
  : process.env.TRADIER_SANDBOX_TOKEN;
const ACCOUNT_ID = process.env.TRADIER_ACCOUNT_ID;
// ─── STATE ──────────────────────────────────────
let activeTrade = null;
let botPaused = false;
let skipNext = false;
let earlyBird = false;
// ─── HELPERS ────────────────────────────────────
async function tradierRequest(method, path, params = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: method === "POST" ? new URLSearchParams(params).toString() : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Tradier non-JSON response: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(JSON.stringify(json));
  }
  return json;
}
function getETTime() {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return {
    hour: et.getHours(),
    minute: et.getMinutes(),
    dateStr: et.toISOString().split("T")[0],
  };
}
function isInTradingWindow() {
  const { hour, minute } = getETTime();
  const mins = hour * 60 + minute;
  return mins >= 645 && mins <= 900;
}
// ─── MARKET FUNCTIONS ───────────────────────────
async function getTodayExpiration() {
  console.log("📅 Fetching expirations...");
  const data = await tradierRequest("GET", "/markets/options/expirations?symbol=SPY");
  console.log("📅 Expiration response:", JSON.stringify(data).slice(0, 200));
  const list = data?.expirations?.date || [];
  const today = getETTime().dateStr;
  if (!list.includes(today)) {
    throw new Error(`No 0DTE available today (${today})`);
  }
  return today;
}
async function getSPYPrice() {
  console.log("💰 Fetching SPY price...");
  const data = await tradierRequest("GET", "/markets/quotes?symbols=SPY");
  console.log("💰 Quote response:", JSON.stringify(data).slice(0, 200));
  return parseFloat(data.quotes.quote.last);
}
async function getATMCall(spyPrice) {
  const expiration = await getTodayExpiration();
  const strike = Math.ceil(spyPrice);
  console.log(`📊 Getting options chain — strike target: ${strike}, expiration: ${expiration}`);
  const data = await tradierRequest(
    "GET",
    `/markets/options/chains?symbol=SPY&expiration=${expiration}`
  );
  const options = data?.options?.option || [];
  if (!options.length) throw new Error("No options returned");
  const calls = options.filter(o => o.option_type === "call");
  const exact = calls.find(o => o.strike === strike);
  if (exact) {
    console.log(`📊 Exact strike found: ${exact.symbol}`);
    return exact;
  }
  const above = calls
    .filter(o => o.strike > spyPrice)
    .sort((a, b) => a.strike - b.strike);
  if (above.length) {
    console.log(`📊 Using next strike above: ${above[0].symbol}`);
    return above[0];
  }
  throw new Error("No ATM call found");
}
// ─── BUYING POWER + POSITION SIZING ─────────────
// Pulls the most conservative "cash you can actually spend on options" value
// from Tradier's balances endpoint. Works for both cash and margin accounts.
async function getOptionBuyingPower() {
  const data = await tradierRequest("GET", `/accounts/${ACCOUNT_ID}/balances`);
  const b = data?.balances || {};
  const candidates = [
    b.margin?.option_buying_power,
    b.cash?.cash_available,
    b.pdt?.option_buying_power,
    b.option_buying_power,
    b.cash_available,
    b.total_cash,
  ]
    .map(v => (v == null ? NaN : parseFloat(v)))
    .filter(v => Number.isFinite(v) && v >= 0);
  if (!candidates.length) {
    throw new Error(`Could not parse buying power from balances: ${JSON.stringify(b)}`);
  }
  // Smallest non-negative value → safest across account types.
  return Math.min(...candidates);
}
// Decide how many contracts (0..MAX_CONTRACTS) we can afford at this ask.
// Returns 0 if we can't even afford one → caller should skip the trade.
function calcContracts(ask, buyingPower) {
  if (!ask || ask <= 0) return 0;
  const usable     = buyingPower * (1 - BP_BUFFER_PCT);
  const costPerCtr = ask * 100;                 // options are 100x multiplier
  const affordable = Math.floor(usable / costPerCtr);
  const qty        = Math.min(MAX_CONTRACTS, affordable);
  return qty >= MIN_CONTRACTS ? qty : 0;
}
// ─── ORDERS ─────────────────────────────────────
async function placeOrder(symbol, side, qty, type, price = null) {
  const params = {
    class: "option",
    symbol: "SPY",
    option_symbol: symbol,
    side,
    quantity: qty,
    type,
    duration: "day",
  };
  if (price) params.price = price;
  console.log(`📤 Placing order:`, JSON.stringify(params));
  const res = await tradierRequest("POST", `/accounts/${ACCOUNT_ID}/orders`, params);
  console.log(`📥 Order response:`, JSON.stringify(res).slice(0, 200));
  return res.order;
}
async function cancelOrder(orderId) {
  try {
    await tradierRequest("DELETE", `/accounts/${ACCOUNT_ID}/orders/${orderId}`);
    console.log(`🗑️ Cancelled order ${orderId}`);
  } catch (err) {
    console.warn(`⚠️ Could not cancel order ${orderId}:`, err.message);
  }
}
async function getOrderStatus(orderId) {
  const data = await tradierRequest(
    "GET",
    `/accounts/${ACCOUNT_ID}/orders/${orderId}`
  );
  return data.order;
}
async function getFillPrice(orderId) {
  for (let i = 0; i < 6; i++) {
    const order = await getOrderStatus(orderId);
    if (order.status === "filled") {
      return parseFloat(order.avg_fill_price);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}
// ─── TRADE OPENER (shared by /webhook and /fire) ───
// Sizes position dynamically from real buying power, up to MAX_CONTRACTS.
// Returns { skipped: true, reason } if we can't afford anything.
async function openTrade() {
  const spy = await getSPYPrice();
  console.log("SPY price:", spy);
  const option = await getATMCall(spy);
  console.log("Option selected:", option.symbol);
  // 💰 Dynamic sizing
  const bp  = await getOptionBuyingPower();
  const ask = parseFloat(option.ask);
  const qty = calcContracts(ask, bp);
  console.log(`💵 BP: $${bp.toFixed(2)}  |  ask: $${ask}  |  sized qty: ${qty} (max ${MAX_CONTRACTS})`);
  if (qty === 0) {
    const reason = `Insufficient buying power: $${bp.toFixed(2)} available, need $${(ask * 100).toFixed(2)} for 1 contract`;
    console.log("⛔", reason);
    return { skipped: true, reason, bp, ask };
  }
  // 🟢 Buy
  const buy = await placeOrder(option.symbol, "buy_to_open", qty, "market");
  const fill = await getFillPrice(buy.id);
  console.log("Buy fill price:", fill);
  const entry = fill ?? ask;
  if (!entry || entry <= 0) {
    throw new Error(`Cannot determine valid entry price (fill=${fill}, ask=${ask})`);
  }
  const target = +(entry * (1 + PROFIT_PCT)).toFixed(2);
  console.log(`🎯 Entry: ${entry} → Target: ${target} (+${(PROFIT_PCT * 100).toFixed(0)}%)`);
  // 🎯 Limit sell
  const sell = await placeOrder(option.symbol, "sell_to_close", qty, "limit", target);
  // ⏰ Time stop — cancel limit first, then market out (uses trade.qty, not a constant)
  const timeout = setTimeout(async () => {
    if (!activeTrade) return;
    console.log("⏰ Time stop — cancelling limit order and selling at market");
    const trade = activeTrade;
    activeTrade = null;
    await cancelOrder(trade.sellId);
    await placeOrder(trade.symbol, "sell_to_close", trade.qty, "market");
  }, TIME_STOP_MIN * 60000);
  activeTrade = {
    symbol: option.symbol,
    qty,                 // ← persisted so every sell path uses the right size
    entry,
    target,
    sellId: sell.id,
    timeout,
    openedAt: Date.now(),
  };
  startSellWatcher(activeTrade);
  console.log(`✅ TRADE OPEN  qty=${qty}  entry=${entry} → ${target} (+${(PROFIT_PCT * 100).toFixed(0)}%)`);
  return { ok: true, qty, entry, target, bp };
}
let sellWatcherInterval = null;
function startSellWatcher(trade) {
  // Clear any existing watcher before starting a new one
  if (sellWatcherInterval) {
    clearInterval(sellWatcherInterval);
    sellWatcherInterval = null;
  }
  sellWatcherInterval = setInterval(async () => {
    // Always read sellId from activeTrade so breakeven updates are picked up
    if (!activeTrade) {
      clearInterval(sellWatcherInterval);
      sellWatcherInterval = null;
      return;
    }
    try {
      const order = await getOrderStatus(activeTrade.sellId);
      if (order.status === "filled") {
        console.log(`✅ PROFIT TARGET HIT — filled @ ${order.avg_fill_price}`);
        clearTimeout(activeTrade.timeout);
        clearInterval(sellWatcherInterval);
        sellWatcherInterval = null;
        activeTrade = null;
      } else if (order.status === "canceled" || order.status === "expired") {
        if (activeTrade) {
          console.warn(`⚠️ Sell order ${activeTrade.sellId} is ${order.status} — closing at market`);
          clearInterval(sellWatcherInterval);
          sellWatcherInterval = null;
          const trade = activeTrade;
          activeTrade = null;
          clearTimeout(trade.timeout);
          await placeOrder(trade.symbol, "sell_to_close", trade.qty, "market");
        }
      }
    } catch (err) {
      console.error("⚠️ Sell watcher error:", err.message);
    }
  }, SELL_POLL_INTERVAL_MS);
}
// ─── WEBHOOK ────────────────────────────────────
app.post("/webhook", async (req, res) => {
  console.log("=== WEBHOOK RECEIVED ===");
  if (botPaused) return res.json({ skip: "paused" });
  if (skipNext) { skipNext = false; return res.json({ skip: "skipNext" }); }
  if (!earlyBird && !isInTradingWindow()) return res.json({ skip: "time" });
  if (activeTrade) return res.json({ skip: "active trade" });
  // earlyBird is one-shot — reset after passing the gate
  if (earlyBird) {
    earlyBird = false;
    console.log("🐦 earlyBird used — resetting to false");
  }
  try {
    const result = await openTrade();
    if (result.skipped) return res.json({ skip: "no_bp", ...result });
    res.json(result);
  } catch (err) {
    console.error("❌ ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});
// ─── CONTROL ROUTES ─────────────────────────────
app.post("/pause", (req, res) => {
  botPaused = true;
  console.log("⏸️ Bot paused");
  res.json({ paused: true });
});
app.post("/resume", (req, res) => {
  botPaused = false;
  console.log("▶️ Bot resumed");
  res.json({ paused: false });
});
app.post("/skip", (req, res) => {
  skipNext = true;
  console.log("⏭️ Next signal will be skipped");
  res.json({ skipNext: true });
});
app.get("/status", (req, res) => {
  res.json({ activeTrade, botPaused, skipNext, earlyBird, maxContracts: MAX_CONTRACTS });
});
// Quick sanity endpoint — tells you exactly what the bot would size a trade at right now.
app.get("/sizing", async (req, res) => {
  try {
    const spy    = await getSPYPrice();
    const option = await getATMCall(spy);
    const bp     = await getOptionBuyingPower();
    const ask    = parseFloat(option.ask);
    const qty    = calcContracts(ask, bp);
    res.json({ spy, strike: option.strike, ask, bp, qty, maxContracts: MAX_CONTRACTS });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ─── EARLYBIRD ──────────────────────────────────
app.post("/earlybird", (req, res) => {
  earlyBird = true;
  console.log("🐦 earlyBird ON — next trade will fire outside time window");
  res.json({ earlyBird: true });
});
// ─── BREAKEVEN ──────────────────────────────────
app.post("/breakeven", async (req, res) => {
  if (!activeTrade) return res.status(400).json({ error: "No active trade" });
  try {
    console.log("⚖️ Setting breakeven sell order...");
    await cancelOrder(activeTrade.sellId);
    const sell = await placeOrder(
      activeTrade.symbol,
      "sell_to_close",
      activeTrade.qty,           // ← dynamic qty
      "limit",
      activeTrade.entry
    );
    activeTrade.sellId = sell.id;
    startSellWatcher(activeTrade); // restart watcher with new sellId
    console.log(`⚖️ Breakeven set @ ${activeTrade.entry}`);
    res.json({ ok: true, breakeven: activeTrade.entry, qty: activeTrade.qty });
  } catch (err) {
    console.error("❌ Breakeven error:", err.message);
    res.status(500).json({ error: err.message });
  }
});
// ─── EXTEND ─────────────────────────────────────
app.post("/extend", (req, res) => {
  if (!activeTrade) return res.status(400).json({ error: "No active trade" });
  clearTimeout(activeTrade.timeout);
  activeTrade.timeout = setTimeout(async () => {
    if (!activeTrade) return;
    console.log("⏰ Extended time stop — cancelling limit and selling at market");
    const trade = activeTrade;
    activeTrade = null;
    await cancelOrder(trade.sellId);
    await placeOrder(trade.symbol, "sell_to_close", trade.qty, "market");
  }, TIME_STOP_MIN * 60000);
  console.log(`⏱️ Timer reset to ${TIME_STOP_MIN} min`);
  res.json({ ok: true, resetTo: TIME_STOP_MIN });
});
// ─── EMERGENCY ──────────────────────────────────
app.post("/emergency", async (req, res) => {
  if (!activeTrade) return res.status(400).json({ error: "No active trade" });
  try {
    console.log("🚨 EMERGENCY — selling all at market");
    const trade = activeTrade;
    activeTrade = null;
    clearTimeout(trade.timeout);
    if (sellWatcherInterval) { clearInterval(sellWatcherInterval); sellWatcherInterval = null; }
    await cancelOrder(trade.sellId);
    await placeOrder(trade.symbol, "sell_to_close", trade.qty, "market");
    res.json({ ok: true, sold: "market", qty: trade.qty });
  } catch (err) {
    console.error("❌ Emergency error:", err.message);
    res.status(500).json({ error: err.message });
  }
});
// ─── FIRE (manual trade entry) ──────────────────
app.post("/fire", async (req, res) => {
  console.log("🔥 FIRE — manual trade triggered");
  if (activeTrade) return res.status(400).json({ error: "Already in a trade" });
  try {
    const result = await openTrade();
    if (result.skipped) return res.status(400).json({ error: result.reason, ...result });
    res.json(result);
  } catch (err) {
    console.error("❌ FIRE error:", err.message);
    res.status(500).json({ error: err.message });
  }
});
// ─── SERVER ─────────────────────────────────────
app.listen(process.env.PORT || 3000, () => {
  console.log(`🚀 BOT RUNNING — ${LIVE_MODE ? "🔴 LIVE" : "🟡 SANDBOX"}  maxContracts=${MAX_CONTRACTS}`);
});
