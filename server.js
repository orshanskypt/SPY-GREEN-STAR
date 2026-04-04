// ============================================================
//  SPY GREEN STAR AUTO TRADER — Render.com Web Service
//  Rules:
//  - Time window  : 10:45 AM – 3:00 PM ET
//  - Entry        : TradingView green star webhook
//  - Strike       : Round UP to nearest whole dollar
//  - Delta        : 0.40 – 0.50 (closest if none in range)
//  - Profit target: +8% on option price
//  - Time stop    : 30 minutes
//  - Contracts    : 10 (paper trading)
// ============================================================
//
//  ENVIRONMENT VARIABLES (set in Render dashboard):
//    TRADIER_SANDBOX_TOKEN  = your Tradier sandbox token
//    TRADIER_LIVE_TOKEN     = your Tradier live token (add later)
//    TRADIER_ACCOUNT_ID     = your Tradier account ID
//    LIVE_MODE              = false (change to true for real money)
//    PORT                   = 3000 (Render sets this automatically)
// ============================================================

import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ─── CONFIGURATION ───────────────────────────────────────────
const LIVE_MODE     = process.env.LIVE_MODE === "true";
const CONTRACTS     = 10;       // contracts per signal (paper trading)
const PROFIT_PCT    = 0.08;     // 8% profit target on option price
const TIME_STOP_MIN = 30;       // minutes before auto-sell
const DELTA_MIN     = 0.40;     // minimum delta
const DELTA_MAX     = 0.50;     // maximum delta

const MARKET_OPEN_HOUR  = 10;  // 10:45 AM ET
const MARKET_OPEN_MIN   = 45;
const MARKET_CLOSE_HOUR = 15;  // 3:00 PM ET
const MARKET_CLOSE_MIN  = 0;

const TRADIER_SANDBOX_BASE = "https://sandbox.tradier.com/v1";
const TRADIER_LIVE_BASE    = "https://api.tradier.com/v1";

const BASE_URL   = LIVE_MODE ? TRADIER_LIVE_BASE    : TRADIER_SANDBOX_BASE;
const API_TOKEN  = LIVE_MODE
  ? process.env.TRADIER_LIVE_TOKEN
  : process.env.TRADIER_SANDBOX_TOKEN;
const ACCOUNT_ID = process.env.TRADIER_ACCOUNT_ID;
// ─────────────────────────────────────────────────────────────

// Track active trade in memory
let activeTrade = null;

// Helper: Tradier API request
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

// Helper: get current ET time
function getETTime() {
  const now = new Date();
  const etString = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const et = new Date(etString);
  return {
    hour: et.getHours(),
    minute: et.getMinutes(),
    dateStr: et.toISOString().split("T")[0],
  };
}

// Helper: is current time within trading window?
function isInTradingWindow() {
  const { hour, minute } = getETTime();
  const nowMins   = hour * 60 + minute;
  const openMins  = MARKET_OPEN_HOUR  * 60 + MARKET_OPEN_MIN;
  const closeMins = MARKET_CLOSE_HOUR * 60 + MARKET_CLOSE_MIN;
  return nowMins >= openMins && nowMins <= closeMins;
}

// Helper: get live SPY price
async function getSPYPrice() {
  const data = await tradierRequest("GET", "/markets/quotes?symbols=SPY");
  const quote = data?.quotes?.quote;
  if (!quote) throw new Error("Could not retrieve SPY quote");
  return parseFloat(quote.last);
}

// Helper: round UP to nearest whole dollar
function roundUpStrike(price) {
  return Math.ceil(price);
}

// Helper: find today's best call option
// Priority: delta 0.40-0.50 at rounded-up strike
// Fallback: closest delta to 0.45 if none in range
async function getBestCallOption(spyPrice) {
  const { dateStr } = getETTime();

  const data = await tradierRequest(
    "GET",
    `/markets/options/chains?symbol=SPY&expiration=${dateStr}&greeks=true`
  );

  const options = data?.options?.option;
  if (!options || options.length === 0) {
    throw new Error(`No options found for SPY expiration ${dateStr}`);
  }

  const calls = options.filter((o) => o.option_type === "call");
  if (calls.length === 0) throw new Error("No call options found for today");

  const targetStrike = roundUpStrike(spyPrice);
  console.log(`SPY price: $${spyPrice} → Target strike: $${targetStrike}`);

  // Try target strike with delta in range
  const atTargetStrike = calls.filter((o) => o.strike === targetStrike);
  const inDeltaRange = atTargetStrike.filter((o) => {
    const delta = o.greeks?.delta;
    return delta && delta >= DELTA_MIN && delta <= DELTA_MAX;
  });

  if (inDeltaRange.length > 0) {
    const best = inDeltaRange[0];
    console.log(`✓ Found at target strike $${targetStrike} delta ${best.greeks?.delta}`);
    return { symbol: best.symbol, strike: best.strike, ask: best.ask, delta: best.greeks?.delta };
  }

  // Fallback: closest delta to 0.45 across all strikes
  console.log(`No option at $${targetStrike} in delta range. Finding closest delta to 0.45...`);
  const withDelta = calls.filter((o) => o.greeks?.delta != null);

  if (withDelta.length === 0) {
    // No Greeks available (common in sandbox) — use rounded-up strike
    console.log("No Greeks available (sandbox) — using rounded-up strike as fallback");
    const fallback = calls.find((o) => o.strike === targetStrike) ||
      calls.reduce((prev, curr) =>
        Math.abs(curr.strike - targetStrike) < Math.abs(prev.strike - targetStrike) ? curr : prev
      );
    return { symbol: fallback.symbol, strike: fallback.strike, ask: fallback.ask, delta: "N/A" };
  }

  const closest = withDelta.reduce((prev, curr) =>
    Math.abs((curr.greeks?.delta || 0) - 0.45) < Math.abs((prev.greeks?.delta || 0) - 0.45)
      ? curr : prev
  );

  console.log(`✓ Fallback: strike $${closest.strike} delta ${closest.greeks?.delta}`);
  return { symbol: closest.symbol, strike: closest.strike, ask: closest.ask, delta: closest.greeks?.delta };
}

// Helper: check for existing open SPY position
async function hasOpenPosition() {
  if (activeTrade) return true;
  const data = await tradierRequest("GET", `/accounts/${ACCOUNT_ID}/positions`);
  const positions = data?.positions?.position;
  if (!positions) return false;
  const posArray = Array.isArray(positions) ? positions : [positions];
  return posArray.some((p) => p.symbol.startsWith("SPY") && p.quantity > 0);
}

// Helper: place buy order
async function placeBuyOrder(optionSymbol) {
  const order = await tradierRequest("POST", `/accounts/${ACCOUNT_ID}/orders`, {
    class: "option",
    symbol: "SPY",
    option_symbol: optionSymbol,
    side: "buy_to_open",
    quantity: CONTRACTS,
    type: "market",
    duration: "day",
  });
  return order?.order;
}

// Helper: place profit target limit sell at +8%
async function placeProfitTargetOrder(optionSymbol, entryPrice) {
  const targetPrice = parseFloat((entryPrice * (1 + PROFIT_PCT)).toFixed(2));
  console.log(`Profit target: $${targetPrice} (entry $${entryPrice} + 8%)`);
  const order = await tradierRequest("POST", `/accounts/${ACCOUNT_ID}/orders`, {
    class: "option",
    symbol: "SPY",
    option_symbol: optionSymbol,
    side: "sell_to_close",
    quantity: CONTRACTS,
    type: "limit",
    price: targetPrice,
    duration: "day",
  });
  return order?.order;
}

// Helper: close position at market (time stop)
async function closePositionAtMarket(optionSymbol, profitOrderId) {
  try {
    await tradierRequest("DELETE", `/accounts/${ACCOUNT_ID}/orders/${profitOrderId}`);
    console.log(`Cancelled profit order ${profitOrderId}`);
  } catch (e) {
    console.log("Could not cancel profit order:", e.message);
  }

  try {
    const orderData = await tradierRequest("GET", `/accounts/${ACCOUNT_ID}/orders/${profitOrderId}`);
    if (orderData?.order?.status === "filled") {
      console.log("Profit target already filled — skipping time stop.");
      activeTrade = null;
      return;
    }
  } catch (e) {
    console.log("Could not check order status:", e.message);
  }

  const sellOrder = await tradierRequest("POST", `/accounts/${ACCOUNT_ID}/orders`, {
    class: "option",
    symbol: "SPY",
    option_symbol: optionSymbol,
    side: "sell_to_close",
    quantity: CONTRACTS,
    type: "market",
    duration: "day",
  });
  console.log(`Time stop market sell placed:`, JSON.stringify(sellOrder));
  activeTrade = null;
}

// ─── WEBHOOK ENDPOINT ─────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  console.log("\n=== WEBHOOK RECEIVED ===");
  console.log(`Mode: ${LIVE_MODE ? "🔴 LIVE" : "🟡 SANDBOX (paper)"}`);

  try {
    // 1. Check trading window
    if (!isInTradingWindow()) {
      const { hour, minute } = getETTime();
      console.log(`Outside window at ${hour}:${String(minute).padStart(2, "0")} ET. Skipping.`);
      return res.json({ status: "skipped", reason: "Outside trading window" });
    }
    console.log("✓ Within trading window (10:45 AM – 3:00 PM ET)");

    // 2. Check for existing position
    const alreadyIn = await hasOpenPosition();
    if (alreadyIn) {
      console.log("Already in a trade. Skipping new signal.");
      return res.json({ status: "skipped", reason: "Already in trade" });
    }
    console.log("✓ No existing position");

    // 3. Get SPY price
    const spyPrice = await getSPYPrice();
    console.log(`✓ SPY price: $${spyPrice}`);

    // 4. Find best call option
    const { symbol: optionSymbol, strike, ask, delta } = await getBestCallOption(spyPrice);
    console.log(`✓ Selected: ${optionSymbol} | Strike: $${strike} | Ask: $${ask} | Delta: ${delta}`);

    // 5. Place buy order
    const buyOrder = await placeBuyOrder(optionSymbol);
    console.log(`✓ Buy order placed: ID ${buyOrder?.id}`);

    const entryPrice = ask || 1.00;

    // 6. Place profit target
    const profitOrder = await placeProfitTargetOrder(optionSymbol, entryPrice);
    const profitOrderId = profitOrder?.id;
    console.log(`✓ Profit target order: ID ${profitOrderId}`);

    // 7. Store active trade
    activeTrade = { optionSymbol, profitOrderId, entryPrice, openedAt: Date.now() };

    // 8. Schedule 30-min time stop
    console.log(`⏰ Time stop scheduled in ${TIME_STOP_MIN} minutes`);
    setTimeout(async () => {
      console.log("\n=== 30-MIN TIME STOP TRIGGERED ===");
      await closePositionAtMarket(optionSymbol, profitOrderId);
    }, TIME_STOP_MIN * 60 * 1000);

    return res.json({
      status: "trade opened",
      mode: LIVE_MODE ? "LIVE" : "SANDBOX",
      spyPrice,
      targetStrike: roundUpStrike(spyPrice),
      optionSymbol,
      strike,
      delta,
      entryPrice,
      profitTarget: parseFloat((entryPrice * 1.08).toFixed(2)),
      timeStopMinutes: TIME_STOP_MIN,
      contracts: CONTRACTS,
      buyOrderId: buyOrder?.id,
      profitOrderId,
    });

  } catch (err) {
    console.error("Error:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "running",
    mode: LIVE_MODE ? "LIVE" : "SANDBOX",
    activeTrade: activeTrade || "none",
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SPY Green Star bot running on port ${PORT}`);
  console.log(`Mode: ${LIVE_MODE ? "🔴 LIVE" : "🟡 SANDBOX (paper)"}`);
  console.log(`Window: 10:45 AM – 3:00 PM ET`);
  console.log(`Strike: Round UP | Delta: ${DELTA_MIN}–${DELTA_MAX} | Target: +8% | Stop: 30 min`);
});
