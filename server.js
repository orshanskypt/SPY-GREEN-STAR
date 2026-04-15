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
// GET /pause     — pause bot
// GET /resume    — resume bot
// GET /skip      — skip next signal only
// GET /earlybird — bypass time window for next signal only
// GET /breakeven — limit sell ALL at entry price
// GET /emergency — market sell ALL immediately
// GET /extend    — keep current position open past 30 min
// GET /status    — check bot state
// ============================================================

import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// === COLD-START PREVENTION ===
app.get('/ping',    (req, res) => res.status(200).send('OK'));
app.get('/healthz', (req, res) => res.status(200).send('OK'));
app.head('/ping',   (req, res) => res.status(200).end());
app.head('/healthz',(req, res) => res.status(200).end());

// ─── CONFIGURATION ───────────────────────────────────────────
const LIVE_MODE   = process.env.LIVE_MODE === "true";
const CONTRACTS   = 2;
const PROFIT_PCT  = 0.08;
const TIME_STOP_MIN = 30;

const TRADIER_SANDBOX_BASE = "https://sandbox.tradier.com/v1";
const TRADIER_LIVE_BASE    = "https://api.tradier.com/v1";
const BASE_URL   = LIVE_MODE ? TRADIER_LIVE_BASE : TRADIER_SANDBOX_BASE;
const API_TOKEN  = LIVE_MODE ? process.env.TRADIER_LIVE_TOKEN : process.env.TRADIER_SANDBOX_TOKEN;
const ACCOUNT_ID = process.env.TRADIER_ACCOUNT_ID;

// ─── BOT STATE ────────────────────────────────────────────────
let activeTrade = null;   // { optionSymbol, entryPrice, limitOrderId, timeoutId }
let botPaused   = false;
let skipNext    = false;
let earlyBird   = false;

console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET] SPY Green Star LIVE bot starting...`);

// ─── HELPERS ──────────────────────────────────────────────────

// FIX 1: tradierRequest now safely handles non-JSON responses (the root cause
//         of "Unexpected token 'I', Invalid Pa... is not valid JSON").
//         Tradier returns plain-text errors like "Invalid Parameters" on bad
//         requests — JSON.parse of that text is what was crashing the bot.
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
  const text = await res.text();  // always read as text first

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // Tradier returned non-JSON (e.g. "Invalid Parameters", HTML error page)
    throw new Error(`Tradier non-JSON response [${res.status}]: ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    // JSON but still an error status — surface the message clearly
    const msg = json?.fault?.faultstring
      || json?.error
      || JSON.stringify(json);
    throw new Error(`Tradier API error [${res.status}]: ${msg}`);
  }

  return json;
}

// FIX 2: getETTime now also returns dateStr (was referenced in getATMCallOption
//         but never built, causing "undefined" expiration in the options chain call).
function getETTime() {
  const now = new Date();
  const etString = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const et = new Date(etString);

  const year  = et.getFullYear();
  const month = String(et.getMonth() + 1).padStart(2, '0');
  const day   = String(et.getDate()).padStart(2, '0');
  const dateStr = `${year}-${month}-${day}`;   // e.g. "2026-04-15"

  return {
    hour: et.getHours(),
    minute: et.getMinutes(),
    dateStr,
  };
}

function isInTradingWindow() {
  const { hour, minute } = getETTime();
  const nowMins   = hour * 60 + minute;
  const openMins  = 10 * 60 + 45;
  const closeMins = 15 * 60 + 0;
  return nowMins >= openMins && nowMins <= closeMins;
}

async function getSPYPrice() {
  const data  = await tradierRequest("GET", "/markets/quotes?symbols=SPY");
  const quote = data?.quotes?.quote;
  if (!quote) throw new Error("Could not retrieve SPY quote");
  return parseFloat(quote.last);
}

// FIX 3: getATMCallOption now uses dateStr from getETTime() correctly.
async function getATMCallOption(spyPrice) {
  const { dateStr } = getETTime();
  const targetStrike = Math.ceil(spyPrice);

  const data = await tradierRequest(
    "GET",
    `/markets/options/chains?symbol=SPY&expiration=${dateStr}&greeks=false`
  );

  const options = data?.options?.option || [];
  if (options.length === 0) {
    throw new Error(`No options chain returned for SPY on ${dateStr} — market may be closed or no 0DTE available`);
  }

  const calls = options.filter((o) => o.option_type === "call");
  const exact = calls.find((o) => o.strike === targetStrike);
  if (exact) return { symbol: exact.symbol, strike: exact.strike, ask: exact.ask };

  const above = calls
    .filter((o) => o.strike > spyPrice)
    .sort((a, b) => a.strike - b.strike);

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
  if (price !== null) params.price = price.toFixed(2);

  const order = await tradierRequest("POST", `/accounts/${ACCOUNT_ID}/orders`, params);
  if (!order?.order?.id) throw new Error(`Order placement failed — no order ID returned: ${JSON.stringify(order)}`);
  return order.order;
}

async function cancelOrder(orderId) {
  try {
    await tradierRequest("DELETE", `/accounts/${ACCOUNT_ID}/orders/${orderId}`);
  } catch (e) {
    console.warn(`[cancelOrder] Could not cancel order ${orderId}: ${e.message}`);
  }
}

// FIX 4: Poll for actual filled price after market buy so the limit and logs
//         reflect the real fill, not the pre-trade ask snapshot.
async function getFilledPrice(orderId, maxWaitMs = 8000) {
  const interval = 1000;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const data = await tradierRequest("GET", `/accounts/${ACCOUNT_ID}/orders/${orderId}`);
      const o = data?.order;
      if (o?.status === "filled" && o?.avg_fill_price) {
        return parseFloat(o.avg_fill_price);
      }
    } catch (e) {
      console.warn(`[getFilledPrice] poll error: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, interval));
  }
  console.warn(`[getFilledPrice] timed out waiting for fill on order ${orderId} — falling back to ask`);
  return null;
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
  const { optionSymbol, limitOrderId, timeoutId } = activeTrade;

  if (timeoutId) clearTimeout(timeoutId);
  if (limitOrderId) await cancelOrder(limitOrderId);

  const closeOrder = await placeOrder(
    optionSymbol,
    "sell_to_close",
    CONTRACTS,
    type,
    price
  );
  activeTrade = null;
  return {
    message: `Closed ${CONTRACTS} contracts`,
    type,
    price: price ?? "market",
    orderId: closeOrder?.id,
  };
}

// ─── CONTROL ENDPOINTS ────────────────────────────────────────
app.get('/pause',     (req, res) => { botPaused = true;  skipNext = false; earlyBird = false; res.json({ status: 'paused' }); });
app.get('/resume',    (req, res) => { botPaused = false; skipNext = false; earlyBird = false; res.json({ status: 'resumed' }); });
app.get('/skip',      (req, res) => { skipNext  = true;  res.json({ status: 'skip_set' }); });
app.get('/earlybird', (req, res) => { earlyBird = true;  res.json({ status: 'earlybird_set' }); });

app.get('/breakeven', async (req, res) => {
  if (!activeTrade) return res.json({ status: 'error', message: 'No active trade' });
  try {
    const result = await closeAllPositions("limit", activeTrade.entryPrice);
    res.json({ status: 'breakeven_placed', ...result });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.get('/emergency', async (req, res) => {
  if (!activeTrade) return res.json({ status: 'error', message: 'No active trade' });
  try {
    const result = await closeAllPositions("market");
    res.json({ status: 'emergency_closed', ...result });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

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
    activeTrade: activeTrade
      ? { optionSymbol: activeTrade.optionSymbol, entryPrice: activeTrade.entryPrice }
      : 'none',
  });
});

// ─── WEBHOOK ENDPOINT ─────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  console.log("\n=== WEBHOOK RECEIVED (LIVE 2-contract mode) ===");

  if (botPaused)  return res.json({ status: "skipped", reason: "Bot paused" });
  if (skipNext)   { skipNext = false; return res.json({ status: "skipped", reason: "Skip next" }); }

  if (earlyBird) {
    earlyBird = false;
    console.log("🐦 EARLYBIRD — time window bypassed");
  } else if (!isInTradingWindow()) {
    return res.json({ status: "skipped", reason: "Outside trading window" });
  }

  if (activeTrade) return res.json({ status: "skipped", reason: "Already in trade" });

  try {
    const spyPrice = await getSPYPrice();
    console.log(`SPY price: $${spyPrice}`);

    const { symbol: optionSymbol, ask } = await getATMCallOption(spyPrice);
    console.log(`ATM call: ${optionSymbol} | Ask: $${ask}`);

    // Buy 2 contracts at market
    const buyOrder = await placeOrder(optionSymbol, "buy_to_open", CONTRACTS, "market");
    console.log(`Buy order placed: ${buyOrder.id}`);

    // FIX 4: Wait for actual fill price; fall back to ask if polling times out
    const filledPrice = await getFilledPrice(buyOrder.id);
    const entryPrice  = filledPrice ?? ask ?? 1.00;
    console.log(`Entry price: $${entryPrice.toFixed(2)}${filledPrice ? " (filled)" : " (ask fallback)"}`);

    // Single +8% limit sell for ALL contracts
    const limitPrice = parseFloat((entryPrice * (1 + PROFIT_PCT)).toFixed(2));
    const limitOrder = await placeOrder(optionSymbol, "sell_to_close", CONTRACTS, "limit", limitPrice);
    console.log(`Limit sell placed: ${limitOrder.id} @ $${limitPrice}`);

    // 30-minute time stop
    const timeoutId = setTimeout(async () => {
      if (!activeTrade) return;
      console.log("⏰ 30-min time stop — checking limit order...");
      if (await isOrderFilled(limitOrder.id)) {
        console.log("✅ Limit already filled — nothing to do");
        activeTrade = null;
        return;
      }
      console.log("⏰ Limit not filled — market selling remaining contracts");
      await cancelOrder(limitOrder.id);
      try {
        await placeOrder(optionSymbol, "sell_to_close", CONTRACTS, "market");
      } catch (e) {
        console.error(`[time stop] market sell failed: ${e.message}`);
      }
      activeTrade = null;
    }, TIME_STOP_MIN * 60 * 1000);

    activeTrade = { optionSymbol, entryPrice, limitOrderId: limitOrder.id, timeoutId };

    console.log(`✅ LIVE TRADE OPENED — ${optionSymbol} | Entry $${entryPrice.toFixed(2)} | Limit @ $${limitPrice} (+8%)`);

    return res.json({
      status: "trade opened",
      mode: "LIVE",
      optionSymbol,
      entryPrice,
      limitPrice,
      timeStopMinutes: TIME_STOP_MIN,
    });

  } catch (err) {
    console.error("❌ Webhook error:", err.message);
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
