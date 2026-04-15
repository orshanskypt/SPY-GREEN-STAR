import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// === HEALTH ===
app.get('/ping', (req, res) => res.send('OK'));
app.get('/healthz', (req, res) => res.send('OK'));

// ─── CONFIG ─────────────────────────────────────
const LIVE_MODE = process.env.LIVE_MODE === "true";
const CONTRACTS = 2;
const PROFIT_PCT = 0.08;           // ✅ single source of truth for profit target
const TIME_STOP_MIN = 30;
const SELL_POLL_INTERVAL_MS = 10000; // check sell fill every 10s

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
  const data = await tradierRequest("GET", "/markets/options/expirations?symbol=SPY");
  const list = data?.expirations?.date || [];
  const today = getETTime().dateStr;
  if (!list.includes(today)) {
    throw new Error(`No 0DTE available today (${today})`);
  }
  return today;
}

async function getSPYPrice() {
  const data = await tradierRequest("GET", "/markets/quotes?symbols=SPY");
  return parseFloat(data.quotes.quote.last);
}

async function getATMCall(spyPrice) {
  const expiration = await getTodayExpiration();
  const strike = Math.ceil(spyPrice);
  const data = await tradierRequest(
    "GET",
    `/markets/options/chains?symbol=SPY&expiration=${expiration}`
  );
  const options = data?.options?.option || [];
  if (!options.length) throw new Error("No options returned");
  const calls = options.filter(o => o.option_type === "call");
  const exact = calls.find(o => o.strike === strike);
  if (exact) return exact;
  const above = calls
    .filter(o => o.strike > spyPrice)
    .sort((a, b) => a.strike - b.strike);
  if (above.length) return above[0];
  throw new Error("No ATM call found");
}

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
  const res = await tradierRequest("POST", `/accounts/${ACCOUNT_ID}/orders`, params);
  return res.order;
}

// ✅ FIX: cancel an open order before replacing it
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

// ✅ FIX: poll for sell fill so activeTrade clears when profit target hits
function startSellWatcher(trade) {
  const interval = setInterval(async () => {
    // Trade was already closed by time stop — stop watching
    if (!activeTrade || activeTrade.sellId !== trade.sellId) {
      clearInterval(interval);
      return;
    }
    try {
      const order = await getOrderStatus(trade.sellId);
      if (order.status === "filled") {
        console.log(`✅ PROFIT TARGET HIT — filled @ ${order.avg_fill_price}`);
        clearTimeout(activeTrade.timeout);
        clearInterval(interval);
        activeTrade = null;
      } else if (order.status === "canceled" || order.status === "expired") {
        console.warn(`⚠️ Sell order ${trade.sellId} is ${order.status} — closing at market`);
        clearInterval(interval);
        await placeOrder(trade.symbol, "sell_to_close", CONTRACTS, "market");
        clearTimeout(activeTrade?.timeout);
        activeTrade = null;
      }
    } catch (err) {
      console.error("⚠️ Sell watcher error:", err.message);
    }
  }, SELL_POLL_INTERVAL_MS);

  return interval;
}

// ─── WEBHOOK ────────────────────────────────────
app.post("/webhook", async (req, res) => {
  console.log("=== WEBHOOK ===");
  if (botPaused) return res.json({ skip: "paused" });
  if (skipNext) { skipNext = false; return res.json({ skip: "skipNext" }); }
  if (!earlyBird && !isInTradingWindow()) return res.json({ skip: "time" });
  if (activeTrade) return res.json({ skip: "active trade" });

  try {
    const spy = await getSPYPrice();
    console.log("SPY:", spy);

    const option = await getATMCall(spy);
    console.log("Option:", option.symbol);

    const buy = await placeOrder(option.symbol, "buy_to_open", CONTRACTS, "market");
    const fill = await getFillPrice(buy.id);

    // ✅ FIX: safe entry price — warn loudly if we can't determine it
    const entry = fill ?? option.ask;
    if (!entry || entry <= 0) {
      throw new Error(`Cannot determine valid entry price (fill=${fill}, ask=${option.ask})`);
    }

    // ✅ FIX: use PROFIT_PCT constant
    const target = +(entry * (1 + PROFIT_PCT)).toFixed(2);

    const sell = await placeOrder(
      option.symbol,
      "sell_to_close",
      CONTRACTS,
      "limit",
      target
    );

    // ✅ FIX: cancel limit order FIRST, then market sell — prevents double-sell
    const timeout = setTimeout(async () => {
      if (!activeTrade) return;
      console.log("⏰ Time stop — cancelling limit order and selling at market");
      const trade = activeTrade;
      activeTrade = null; // clear first to stop the sell watcher
      await cancelOrder(trade.sellId);
      await placeOrder(trade.symbol, "sell_to_close", CONTRACTS, "market");
    }, TIME_STOP_MIN * 60000);

    activeTrade = {
      symbol: option.symbol,
      entry,
      sellId: sell.id,
      timeout,
    };

    // Start watching for the profit-target fill
    startSellWatcher(activeTrade);

    console.log(`✅ TRADE OPEN ${entry} → ${target} (+${(PROFIT_PCT * 100).toFixed(0)}%)`);
    res.json({ ok: true, entry, target });

  } catch (err) {
    console.error("❌ ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── CONTROL ROUTES ─────────────────────────────
app.post("/pause",  (req, res) => { botPaused = true;  res.json({ paused: true }); });
app.post("/resume", (req, res) => { botPaused = false; res.json({ paused: false }); });
app.post("/skip",   (req, res) => { skipNext = true;   res.json({ skipNext: true }); });
app.get("/status",  (req, res) => res.json({ activeTrade, botPaused, skipNext, earlyBird }));

// ─── SERVER ─────────────────────────────────────
app.listen(process.env.PORT || 3000, () => {
  console.log(`🚀 BOT RUNNING — ${LIVE_MODE ? "🔴 LIVE" : "🟡 SANDBOX"}`);
});
