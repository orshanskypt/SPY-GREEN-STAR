// ============================================================
//  SPY GREEN STAR AUTO TRADER — Render.com Web Service
//  Rules:
//  - Time window  : 10:45 AM – 3:00 PM ET
//  - Entry        : TradingView green star webhook
//  - Strike       : Round UP to nearest whole dollar
//  - Delta        : 0.40 – 0.50 (closest if none in range)
//  - Contracts    : 20 (paper trading)
//  - Exit 1       : 75% of filled contracts at +8% (limit order)
//  - Exit 2       : 25% runners — +20% target OR 10% trailing stop from peak
//  - Time stop    : 30 minutes — closes ALL remaining contracts
// ============================================================

import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// === COLD-START PREVENTION ===
app.get('/ping',    (req, res) => res.status(200).send('OK'));
app.get('/healthz', (req, res) => res.status(200).send('OK'));
app.head('/ping',    (req, res) => res.status(200).end());
app.head('/healthz', (req, res) => res.status(200).end());

// ─── CONFIGURATION ───────────────────────────────────────────
const LIVE_MODE       = process.env.LIVE_MODE === "true";
const CONTRACTS       = 20;      // total contracts to buy
const PROFIT_PCT      = 0.08;    // 8% first exit target
const RUNNER_PCT      = 0.20;    // 20% runner take profit from entry
const TRAILING_STOP   = 0.10;    // 10% trailing stop from peak on runners
const TIME_STOP_MIN   = 30;      // hard close all at 30 min
const DELTA_MIN       = 0.40;
const DELTA_MAX       = 0.50;

const MARKET_OPEN_HOUR  = 10;
const MARKET_OPEN_MIN   = 45;
const MARKET_CLOSE_HOUR = 15;
const MARKET_CLOSE_MIN  = 0;

const TRADIER_SANDBOX_BASE = "https://sandbox.tradier.com/v1";
const TRADIER_LIVE_BASE    = "https://api.tradier.com/v1";
const BASE_URL   = LIVE_MODE ? TRADIER_LIVE_BASE    : TRADIER_SANDBOX_BASE;
const API_TOKEN  = LIVE_MODE ? process.env.TRADIER_LIVE_TOKEN : process.env.TRADIER_SANDBOX_TOKEN;
const ACCOUNT_ID = process.env.TRADIER_ACCOUNT_ID;
// ─────────────────────────────────────────────────────────────

let activeTrade = null;

console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET] Server starting...`);

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

// Helper: get live option price
async function getOptionPrice(optionSymbol) {
  const data = await tradierRequest("GET", `/markets/quotes?symbols=${optionSymbol}`);
  const quote = data?.quotes?.quote;
  if (!quote) return null;
  return parseFloat(quote.last || quote.ask || 0);
}

// Helper: round UP to nearest whole dollar
function roundUpStrike(price) {
  return Math.ceil(price);
}

// Helper: calculate 75/25 split — runners always round DOWN, first exit gets remainder
function calcSplit(totalFilled) {
  const runners  = Math.floor(totalFilled * 0.25);
  const firstExit = totalFilled - runners;
  return { firstExit, runners };
}

// Helper: find today's best call option
async function getBestCallOption(spyPrice) {
  const { dateStr } = getETTime();
  const data = await tradierRequest(
    "GET",
    `/markets/options/chains?symbol=SPY&expiration=${dateStr}&greeks=true`
  );
  const options = data?.options?.option;
  if (!options || options.length === 0) throw new Error(`No options found for SPY expiration ${dateStr}`);

  const calls = options.filter((o) => o.option_type === "call");
  if (calls.length === 0) throw new Error("No call options found for today");

  const targetStrike = roundUpStrike(spyPrice);
  console.log(`SPY price: $${spyPrice} → Target strike: $${targetStrike}`);

  const atTargetStrike = calls.filter((o) => o.strike === targetStrike);
  const inDeltaRange   = atTargetStrike.filter((o) => {
    const delta = o.greeks?.delta;
    return delta && delta >= DELTA_MIN && delta <= DELTA_MAX;
  });

  if (inDeltaRange.length > 0) {
    const best = inDeltaRange[0];
    console.log(`✓ Found at target strike $${targetStrike} delta ${best.greeks?.delta}`);
    return { symbol: best.symbol, strike: best.strike, ask: best.ask, delta: best.greeks?.delta };
  }

  console.log(`No option at $${targetStrike} in delta range. Finding closest delta to 0.45...`);
  const withDelta = calls.filter((o) => o.greeks?.delta != null);

  if (withDelta.length === 0) {
    console.log("No Greeks available (sandbox) — using rounded-up strike as fallback");
    const fallback = calls.find((o) => o.strike === targetStrike) ||
      calls.reduce((prev, curr) =>
        Math.abs(curr.strike - targetStrike) < Math.abs(prev.strike - targetStrike) ? curr : prev
      );
    return { symbol: fallback.symbol, strike: fallback.strike, ask: fallback.ask, delta: "N/A" };
  }

  const closest = withDelta.reduce((prev, curr) =>
    Math.abs((curr.greeks?.delta || 0) - 0.45) < Math.abs((prev.greeks?.delta || 0) - 0.45) ? curr : prev
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

// Helper: place order
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

// Helper: cancel an order safely
async function cancelOrder(orderId) {
  try {
    await tradierRequest("DELETE", `/accounts/${ACCOUNT_ID}/orders/${orderId}`);
    console.log(`Cancelled order ${orderId}`);
  } catch (e) {
    console.log(`Could not cancel order ${orderId}:`, e.message);
  }
}

// Helper: check if order is filled
async function isOrderFilled(orderId) {
  try {
    const data = await tradierRequest("GET", `/accounts/${ACCOUNT_ID}/orders/${orderId}`);
    return data?.order?.status === "filled";
  } catch (e) {
    return false;
  }
}

// Runner monitor — polls every 15 seconds for trailing stop and target
async function monitorRunners(optionSymbol, runnerQty, entryPrice, runnerLimitOrderId, stopTimeMs) {
  console.log(`\n🏃 Runner monitor started: ${runnerQty} contracts`);
  console.log(`   Entry: $${entryPrice} | Target: $${(entryPrice * (1 + RUNNER_PCT)).toFixed(2)} | Trailing stop: 10% from peak`);

  let peakPrice  = entryPrice;
  const targetPrice = parseFloat((entryPrice * (1 + RUNNER_PCT)).toFixed(2));

  const interval = setInterval(async () => {
    try {
      // Time stop check
      if (Date.now() >= stopTimeMs) {
        console.log("⏰ 30-min stop reached — closing runners at market");
        clearInterval(interval);
        await cancelOrder(runnerLimitOrderId);
        await placeOrder(optionSymbol, "sell_to_close", runnerQty, "market");
        activeTrade = null;
        return;
      }

      // Check if runner limit order already filled
      if (await isOrderFilled(runnerLimitOrderId)) {
        console.log(`✅ Runner target hit at $${targetPrice}`);
        clearInterval(interval);
        activeTrade = null;
        return;
      }

      // Get current option price
      const currentPrice = await getOptionPrice(optionSymbol);
      if (!currentPrice || currentPrice <= 0) return;

      // Update peak
      if (currentPrice > peakPrice) {
        peakPrice = currentPrice;
        console.log(`📈 New peak: $${peakPrice.toFixed(2)}`);
      }

      // Trailing stop check — only activate after 8% first exit was hit
      // (runners are only alive after first exit, so entry price is already profitable)
      const trailingStopPrice = parseFloat((peakPrice * (1 - TRAILING_STOP)).toFixed(2));
      if (currentPrice <= trailingStopPrice) {
        console.log(`🛑 Trailing stop hit — current $${currentPrice} <= stop $${trailingStopPrice} (peak $${peakPrice})`);
        clearInterval(interval);
        await cancelOrder(runnerLimitOrderId);
        await placeOrder(optionSymbol, "sell_to_close", runnerQty, "market");
        activeTrade = null;
        return;
      }

      console.log(`👀 Runners: current $${currentPrice.toFixed(2)} | peak $${peakPrice.toFixed(2)} | stop $${trailingStopPrice.toFixed(2)} | target $${targetPrice}`);

    } catch (e) {
      console.log("Runner monitor error:", e.message);
    }
  }, 15000); // check every 15 seconds
}

// ─── WEBHOOK ENDPOINT ─────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const startTime = Date.now();
  console.log("\n=== WEBHOOK RECEIVED ===");
  console.log(`Mode: ${LIVE_MODE ? "🔴 LIVE" : "🟡 SANDBOX (paper)"}`);

  const uptimeMs = process.uptime() * 1000;
  if (uptimeMs < 10000) {
    console.log(`⚠️  Possible cold start — uptime: ${Math.round(uptimeMs / 1000)}s`);
  }

  try {
    // 1. Check trading window
    if (!isInTradingWindow()) {
      const { hour, minute } = getETTime();
      console.log(`Outside window at ${hour}:${String(minute).padStart(2, "0")} ET. Skipping.`);
      return res.json({ status: "skipped", reason: "Outside trading window" });
    }
    console.log("✓ Within trading window (10:45 AM – 3:00 PM ET)");

    // 2. Check for existing position
    if (await hasOpenPosition()) {
      console.log("Already in a trade. Skipping.");
      return res.json({ status: "skipped", reason: "Already in trade" });
    }
    console.log("✓ No existing position");

    // 3. Get SPY price
    const spyPrice = await getSPYPrice();
    console.log(`✓ SPY price: $${spyPrice}`);

    // 4. Find best call option
    const { symbol: optionSymbol, strike, ask, delta } = await getBestCallOption(spyPrice);
    console.log(`✓ Selected: ${optionSymbol} | Strike: $${strike} | Ask: $${ask} | Delta: ${delta}`);

    // 5. Place buy order (20 contracts)
    const buyOrder = await placeOrder(optionSymbol, "buy_to_open", CONTRACTS, "market");
    const filledQty = buyOrder?.quantity || CONTRACTS; // use actual filled qty
    console.log(`✓ Buy order placed: ID ${buyOrder?.id} | Qty: ${filledQty}`);

    const entryPrice = ask || 1.00;

    // 6. Calculate 75/25 split based on filled quantity
    const { firstExit, runners } = calcSplit(filledQty);
    console.log(`✓ Split: ${firstExit} contracts at 8% target | ${runners} runners`);

    // 7. Place first exit limit order (75% at +8%)
    const firstExitPrice = parseFloat((entryPrice * (1 + PROFIT_PCT)).toFixed(2));
    const firstExitOrder = await placeOrder(optionSymbol, "sell_to_close", firstExit, "limit", firstExitPrice);
    console.log(`✓ First exit order: ${firstExit} contracts at $${firstExitPrice} | ID ${firstExitOrder?.id}`);

    // 8. Place runner limit order (25% at +20%)
    const runnerTargetPrice = parseFloat((entryPrice * (1 + RUNNER_PCT)).toFixed(2));
    const runnerLimitOrder  = await placeOrder(optionSymbol, "sell_to_close", runners, "limit", runnerTargetPrice);
    console.log(`✓ Runner limit order: ${runners} contracts at $${runnerTargetPrice} | ID ${runnerLimitOrder?.id}`);

    // 9. Store active trade
    const stopTimeMs = Date.now() + TIME_STOP_MIN * 60 * 1000;
    activeTrade = { optionSymbol, entryPrice, filledQty, firstExit, runners, openedAt: Date.now() };

    // 10. Schedule 30-min hard stop for first exit contracts
    setTimeout(async () => {
      console.log("\n=== 30-MIN TIME STOP — FIRST EXIT CONTRACTS ===");
      const firstFilled = await isOrderFilled(firstExitOrder?.id);
      if (!firstFilled) {
        await cancelOrder(firstExitOrder?.id);
        await placeOrder(optionSymbol, "sell_to_close", firstExit, "market");
        console.log(`Closed ${firstExit} first-exit contracts at market`);
      } else {
        console.log(`First exit already filled — skipping`);
      }
      activeTrade = null;
    }, TIME_STOP_MIN * 60 * 1000);

    // 11. Start runner monitor (trailing stop + target + time stop)
    if (runners > 0) {
      monitorRunners(optionSymbol, runners, entryPrice, runnerLimitOrder?.id, stopTimeMs);
    }

    console.log(`✅ Webhook processed in ${Date.now() - startTime}ms`);

    return res.json({
      status: "trade opened",
      mode: LIVE_MODE ? "LIVE" : "SANDBOX",
      spyPrice,
      optionSymbol,
      strike,
      delta,
      entryPrice,
      filledQty,
      firstExitContracts: firstExit,
      firstExitPrice,
      runnerContracts: runners,
      runnerTargetPrice,
      trailingStopPct: `${TRAILING_STOP * 100}% from peak`,
      timeStopMinutes: TIME_STOP_MIN,
      buyOrderId: buyOrder?.id,
      firstExitOrderId: firstExitOrder?.id,
      runnerOrderId: runnerLimitOrder?.id,
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
  console.log(`Contracts: ${CONTRACTS} | Split: 75% at +8% / 25% runners at +20% or 10% trailing stop`);
  console.log(`Time stop: ${TIME_STOP_MIN} min hard close on all contracts`);
  console.log(`Ping endpoints: /ping and /healthz`);
});
