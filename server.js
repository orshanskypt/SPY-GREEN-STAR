// ============================================================
// SPY GREEN STAR AUTO TRADER — SIMPLIFIED LIVE VERSION
// Rules (LIVE with 2 contracts):
// - Time window : 10:45 AM – 3:00 PM ET
// - Strike      : Round UP to nearest whole dollar (true ATM)
// - Contracts   : 2
// - Entry       : Market buy
// - Exit        : Limit sell ALL 2 contracts at +8%
// - Time stop   : 30 minutes — market sell remaining contracts
// - New command : /extend → cancels 30-min time stop (keeps position open)
//
// Controls (bookmark on phone):
// GET /pause — pause bot
// GET /resume — resume bot
// GET /skip — skip next signal only
// GET /earlybird — bypass time window for next signal only
// GET /breakeven — limit sell ALL at entry price
// GET /emergency — market sell ALL immediately
// GET /extend — keep current position open past 30 min
// GET /status — check bot state
// ============================================================

import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// === COLD-START PREVENTION ===
app.get('/ping', (req, res) => res.status(200).send('OK'));
app.get('/healthz', (req, res) => res.status(200).send('OK'));
app.head('/ping', (req, res) => res.status(200).end());
app.head('/healthz', (req, res) => res.status(200).end());

// ─── CONFIGURATION ───────────────────────────────────────────
const LIVE_MODE = process.env.LIVE_MODE === "true";           // ← Set to true on Render
const CONTRACTS = 2;                                          // ← 2 contracts only
const PROFIT_PCT = 0.08;
const TIME_STOP_MIN = 30;

const TRADIER_SANDBOX_BASE = "https://sandbox.tradier.com/v1";
const TRADIER_LIVE_BASE = "https://api.tradier.com/v1";
const BASE_URL = LIVE_MODE ? TRADIER_LIVE_BASE : TRADIER_SANDBOX_BASE;
const API_TOKEN = LIVE_MODE ? process.env.TRADIER_LIVE_TOKEN : process.env.TRADIER_SANDBOX_TOKEN;
const ACCOUNT_ID = process.env.TRADIER_ACCOUNT_ID;

// ─── BOT STATE ────────────────────────────────────────────────
let activeTrade = null;   // { optionSymbol, entryPrice, limitOrderId, timeoutId }
let botPaused = false;
let skipNext = false;
let earlyBird = false;

console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET] SPY Green Star LIVE bot starting...`);

// ─── HELPERS ──────────────────────────────────────────────────
async function tradierRequest(method, path, params = {}) {
  const url = `${BASE_URL}${path}`;
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };
  if (method === "POST") {
    options.body = new URLSearchParams(params).toString();
  }
  const res = await fetch(url, options);
  const json = await res.json();
  if (!res.ok) throw new Error(`Tradier error: ${JSON.stringify(json)}`);
  return json;
}

function getETTime() {
  const now = new Date();
  const etString = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const et = new Date(etString);
  return {
    hour: et.getHours(),
    minute: et.getMinutes(),
  };
}

function isInTradingWindow() {
  const { hour, minute } = getETTime();
  const nowMins = hour * 60 + minute;
  const openMins = 10 * 60 + 45;
  const closeMins = 15 * 60 + 0;
  return nowMins >= openMins && nowMins <= closeMins;
}

async function getSPYPrice() {
  const data = await tradierRequest("GET", "/markets/quotes?symbols=SPY");
  const quote = data?.quotes?.quote;
  if (!quote) throw new Error("Could not retrieve SPY quote");
  return parseFloat(quote.last);
}

async function getATMCallOption(spyPrice) {
  const { dateStr } = getETTime(); // reuse helper logic
  const targetStrike = Math.ceil(spyPrice);
  const data = await tradierRequest(
    "GET",
    `/markets/options/chains?symbol=SPY&expiration=${dateStr}&greeks=false`
  );
  const options = data?.options?.option || [];
  const calls = options.filter((o) => o.option_type === "call");
  const exact = calls.find((o) => o.strike === targetStrike);
  if (exact) return { symbol: exact.symbol, strike: exact.strike, ask: exact.ask };
  const above = calls.filter((o) => o.strike > spyPrice).sort((a, b) => a.strike - b.strike);
  if (above.length > 0) return { symbol: above[0].symbol, strike: above[0].strike, ask: above[0].ask };
  throw new Error("Could not find valid ATM call");
}

async function placeOrder(optionSymbol, side, quantity, type, price = null) {
  const params = {
    class: "option",
    symbol: "SPY",
    option_symbol: optionSymbol,
    side,
    quantity,
    type,
    duration: "day",
  };
  if (price) params.price = price;
  const order = await tradierRequest("POST", `/accounts/${ACCOUNT_ID}/orders`, params);
  return order?.order;
}

async function cancelOrder(orderId) {
  try {
    await tradierRequest("DELETE", `/accounts/${ACCOUNT_ID}/orders/${orderId}`);
  } catch (e) {}
}

async function isOrderFilled(orderId) {
  try {
    const data = await tradierRequest("GET", `/accounts/${ACCOUNT_ID}/orders/${orderId}`);
    return data?.order?.status === "filled";
  } catch (e) {
    return false;
  }
}

// Close everything (used by breakeven / emergency)
async function closeAllPositions(type, price = null) {
  if (!activeTrade) return { message: "No active trade" };
  const { optionSymbol, limitOrderId } = activeTrade;

  if (limitOrderId) await cancelOrder(limitOrderId);

  const closeOrder = await placeOrder(optionSymbol, "sell_to_close", CONTRACTS, type, price);
  activeTrade = null;
  return { message: `Closed ${CONTRACTS} contracts`, type, price: price || "market", orderId: closeOrder?.id };
}

// ─── CONTROL ENDPOINTS ────────────────────────────────────────
app.get('/pause', (req, res) => { botPaused = true; skipNext = false; earlyBird = false; res.json({ status: 'paused' }); });
app.get('/resume', (req, res) => { botPaused = false; skipNext = false; earlyBird = false; res.json({ status: 'resumed' }); });
app.get('/skip', (req, res) => { skipNext = true; res.json({ status: 'skip_set' }); });
app.get('/earlybird', (req, res) => { earlyBird = true; res.json({ status: 'earlybird_set' }); });

app.get('/breakeven', async (req, res) => {
  if (!activeTrade) return res.json({ status: 'error', message: 'No active trade' });
  const result = await closeAllPositions("limit", activeTrade.entryPrice);
  res.json({ status: 'breakeven_placed', ...result });
});

app.get('/emergency', async (req, res) => {
  if (!activeTrade) return res.json({ status: 'error', message: 'No active trade' });
  const result = await closeAllPositions("market");
  res.json({ status: 'emergency_closed', ...result });
});

// NEW: Keep position open past 30 min
app.get('/extend', (req, res) => {
  if (!activeTrade || !activeTrade.timeoutId) {
    return res.json({ status: 'error', message: 'No active trade or time stop already cancelled' });
  }
  clearTimeout(activeTrade.timeoutId);
  delete activeTrade.timeoutId;
  console.log('⏳ TIME STOP EXTENDED — position will stay open');
  res.json({ status: 'extended', message: '30-minute time stop cancelled for current trade' });
});

app.get('/status', (req, res) => {
  res.json({
    status: botPaused ? 'PAUSED' : skipNext ? 'SKIP_NEXT' : earlyBird ? 'EARLYBIRD' : 'ACTIVE',
    mode: LIVE_MODE ? 'LIVE' : 'SANDBOX',
    activeTrade: activeTrade ? { optionSymbol: activeTrade.optionSymbol, entryPrice: activeTrade.entryPrice } : 'none'
  });
});

// ─── WEBHOOK ENDPOINT ─────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const startTime = Date.now();
  console.log("\n=== WEBHOOK RECEIVED (LIVE 2-contract mode) ===");

  if (botPaused) return res.json({ status: "skipped", reason: "Bot paused" });
  if (skipNext) { skipNext = false; return res.json({ status: "skipped", reason: "Skip next" }); }

  if (earlyBird) {
    earlyBird = false;
    console.log("🐦 EARLYBIRD — time window bypassed");
  } else if (!isInTradingWindow()) {
    return res.json({ status: "skipped", reason: "Outside trading window" });
  }

  if (activeTrade) return res.json({ status: "skipped", reason: "Already in trade" });

  try {
    const spyPrice = await getSPYPrice();
    const { symbol: optionSymbol, ask } = await getATMCallOption(spyPrice);

    // Buy 2 contracts
    const buyOrder = await placeOrder(optionSymbol, "buy_to_open", CONTRACTS, "market");
    const entryPrice = ask || 1.00;

    // Single +8% limit sell for ALL contracts
    const limitPrice = parseFloat((entryPrice * (1 + PROFIT_PCT)).toFixed(2));
    const limitOrder = await placeOrder(optionSymbol, "sell_to_close", CONTRACTS, "limit", limitPrice);

    // 30-minute time stop
    const timeoutId = setTimeout(async () => {
      if (!activeTrade) return;
      if (await isOrderFilled(limitOrder.id)) {
        activeTrade = null;
        return;
      }
      console.log("⏰ 30-min time stop hit — market selling remaining contracts");
      await cancelOrder(limitOrder.id);
      await placeOrder(optionSymbol, "sell_to_close", CONTRACTS, "market");
      activeTrade = null;
    }, TIME_STOP_MIN * 60 * 1000);

    // Store trade state
    activeTrade = {
      optionSymbol,
      entryPrice,
      limitOrderId: limitOrder.id,
      timeoutId
    };

    console.log(`✅ LIVE TRADE OPENED — ${optionSymbol} | Entry $${entryPrice.toFixed(2)} | Limit @ $${limitPrice} (+8%)`);

    return res.json({
      status: "trade opened",
      mode: "LIVE",
      optionSymbol,
      entryPrice,
      limitPrice,
      timeStopMinutes: TIME_STOP_MIN
    });
  } catch (err) {
    console.error("Error:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

app.get("/", (req, res) => res.json({ status: "running", mode: LIVE_MODE ? "LIVE" : "SANDBOX" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SPY Green Star bot running on port ${PORT}`);
  console.log(`Mode: ${LIVE_MODE ? "🔴 LIVE (2 contracts)" : "🟡 SANDBOX"}`);
  console.log(`Window: 10:45 AM – 3:00 PM ET | Exit: +8% limit | 30-min time stop`);
  console.log(`New command: /extend (cancel time stop)`);
});
