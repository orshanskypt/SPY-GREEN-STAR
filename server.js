// ============================================================
//  SPY GREEN STAR AUTO TRADER — Render.com Web Service
//  Rules:
//  - Time window  : 10:35 AM – 3:05 PM ET
//  - Before 1 PM  : Rounded-up strike, confirm delta 0.40–0.50
//  - After 1 PM   : Delta priority — closest to 0.45 regardless of strike
//  - Contracts    : 20 (paper trading)
//  - Exit 1       : 75% of filled contracts at +8% (limit order)
//  - Exit 2       : 25% runners — +20% target OR 10% trailing stop from peak
//  - Time stop    : 30 minutes — closes ALL remaining contracts
//
//  KILL SWITCH URLS (bookmark on your phone):
//  GET /pause   — pause bot, skip all signals until resumed
//  GET /resume  — resume bot
//  GET /skip    — skip the very next signal only, then auto-resume
//  GET /status  — check current bot state
// ============================================================

import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// === COLD-START PREVENTION ===
app.get('/ping',     (req, res) => res.status(200).send('OK'));
app.get('/healthz',  (req, res) => res.status(200).send('OK'));
app.head('/ping',    (req, res) => res.status(200).end());
app.head('/healthz', (req, res) => res.status(200).end());

// ─── CONFIGURATION ───────────────────────────────────────────
const LIVE_MODE     = process.env.LIVE_MODE === "true";
const CONTRACTS     = 20;
const PROFIT_PCT    = 0.08;
const RUNNER_PCT    = 0.20;
const TRAILING_STOP = 0.10;
const TIME_STOP_MIN = 30;
const DELTA_MIN     = 0.40;
const DELTA_MAX     = 0.50;
const DELTA_TARGET  = 0.45;

const MARKET_OPEN_HOUR   = 10;
const MARKET_OPEN_MIN    = 35;
const MARKET_CLOSE_HOUR  = 15;
const MARKET_CLOSE_MIN   = 5;

const DELTA_PRIORITY_HOUR = 13;
const DELTA_PRIORITY_MIN  = 0;

const TRADIER_SANDBOX_BASE = "https://sandbox.tradier.com/v1";
const TRADIER_LIVE_BASE    = "https://api.tradier.com/v1";
const BASE_URL   = LIVE_MODE ? TRADIER_LIVE_BASE    : TRADIER_SANDBOX_BASE;
const API_TOKEN  = LIVE_MODE ? process.env.TRADIER_LIVE_TOKEN : process.env.TRADIER_SANDBOX_TOKEN;
const ACCOUNT_ID = process.env.TRADIER_ACCOUNT_ID;
// ─────────────────────────────────────────────────────────────

// ─── BOT STATE ────────────────────────────────────────────────
let activeTrade  = null;
let botPaused    = false;   // full pause — skips all signals
let skipNext     = false;   // skip next signal only, then auto-resume

console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET] Server starting...`);

// ─── KILL SWITCH ENDPOINTS ────────────────────────────────────

// Pause bot entirely
app.get('/pause', (req, res) => {
  botPaused = true;
  skipNext  = false;
  console.log('⛔ Bot PAUSED — all signals will be skipped');
  res.json({ status: 'paused', message: 'Bot paused. All signals will be skipped. Hit /resume to re-enable.' });
});

// Resume bot
app.get('/resume', (req, res) => {
  botPaused = false;
  skipNext  = false;
  console.log('✅ Bot RESUMED — signals active');
  res.json({ status: 'resumed', message: 'Bot resumed. Signals active.' });
});

// Skip next signal only
app.get('/skip', (req, res) => {
  skipNext = true;
  console.log('⏭️  Skip next signal — will auto-resume after');
  res.json({ status: 'skip_set', message: 'Next signal will be skipped. Bot auto-resumes after.' });
});

// Status check
app.get('/status', (req, res) => {
  res.json({
    status: botPaused ? 'PAUSED' : skipNext ? 'SKIP_NEXT' : 'ACTIVE',
    botPaused,
    skipNext,
    activeTrade: activeTrade || 'none',
    mode: LIVE_MODE ? 'LIVE' : 'SANDBOX',
  });
});

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
    dateStr: et.toISOString().split("T")[0],
  };
}

function isInTradingWindow() {
  const { hour, minute } = getETTime();
  const nowMins   = hour * 60 + minute;
  const openMins  = MARKET_OPEN_HOUR  * 60 + MARKET_OPEN_MIN;
  const closeMins = MARKET_CLOSE_HOUR * 60 + MARKET_CLOSE_MIN;
  return nowMins >= openMins && nowMins <= closeMins;
}

function isDeltaPriorityMode() {
  const { hour, minute } = getETTime();
  const nowMins   = hour * 60 + minute;
  const deltaMins = DELTA_PRIORITY_HOUR * 60 + DELTA_PRIORITY_MIN;
  return nowMins >= deltaMins;
}

async function getSPYPrice() {
  const data = await tradierRequest("GET", "/markets/quotes?symbols=SPY");
  const quote = data?.quotes?.quote;
  if (!quote) throw new Error("Could not retrieve SPY quote");
  return parseFloat(quote.last);
}

async function getOptionPrice(optionSymbol) {
  const data = await tradierRequest("GET", `/markets/quotes?symbols=${optionSymbol}`);
  const quote = data?.quotes?.quote;
  if (!quote) return null;
  return parseFloat(quote.last || quote.ask || 0);
}

function roundUpStrike(price) {
  return Math.ceil(price);
}

function calcSplit(totalFilled) {
  const runners   = Math.floor(totalFilled * 0.25);
  const firstExit = totalFilled - runners;
  return { firstExit, runners };
}

async function getBestCallOption(spyPrice) {
  const { dateStr } = getETTime();
  const deltaMode = isDeltaPriorityMode();

  console.log(`Strike mode: ${deltaMode ? "🎯 DELTA PRIORITY (after 1 PM)" : "📐 STRIKE FIRST (before 1 PM)"}`);

  const data = await tradierRequest(
    "GET",
    `/markets/options/chains?symbol=SPY&expiration=${dateStr}&greeks=true`
  );

  const options = data?.options?.option;
  if (!options || options.length === 0) throw new Error(`No options found for SPY expiration ${dateStr}`);

  const calls = options.filter((o) => o.option_type === "call");
  if (calls.length === 0) throw new Error("No call options found for today");

  if (deltaMode) {
    const withDelta = calls.filter((o) => o.greeks?.delta != null);
    if (withDelta.length === 0) {
      console.log("No Greeks available — falling back to rounded-up strike");
      const targetStrike = roundUpStrike(spyPrice);
      const fallback = calls.find((o) => o.strike === targetStrike) ||
        calls.reduce((prev, curr) =>
          Math.abs(curr.strike - spyPrice) < Math.abs(prev.strike - spyPrice) ? curr : prev
        );
      return { symbol: fallback.symbol, strike: fallback.strike, ask: fallback.ask, delta: "N/A" };
    }
    const best = withDelta.reduce((prev, curr) =>
      Math.abs((curr.greeks?.delta || 0) - DELTA_TARGET) <
      Math.abs((prev.greeks?.delta || 0) - DELTA_TARGET) ? curr : prev
    );
    console.log(`✓ Delta priority: strike $${best.strike} | delta ${best.greeks?.delta} | ask $${best.ask}`);
    return { symbol: best.symbol, strike: best.strike, ask: best.ask, delta: best.greeks?.delta };
  }

  const targetStrike = roundUpStrike(spyPrice);
  console.log(`SPY price: $${spyPrice} → Target strike: $${targetStrike}`);

  const atTargetStrike = calls.filter((o) => o.strike === targetStrike);
  const inDeltaRange   = atTargetStrike.filter((o) => {
    const delta = o.greeks?.delta;
    return delta && delta >= DELTA_MIN && delta <= DELTA_MAX;
  });

  if (inDeltaRange.length > 0) {
    const best = inDeltaRange[0];
    console.log(`✓ Strike first: $${targetStrike} | delta ${best.greeks?.delta} | ask $${best.ask}`);
    return { symbol: best.symbol, strike: best.strike, ask: best.ask, delta: best.greeks?.delta };
  }

  console.log(`No option at $${targetStrike} in delta range — finding closest delta to 0.45`);
  const withDelta = calls.filter((o) => o.greeks?.delta != null);

  if (withDelta.length === 0) {
    console.log("No Greeks available (sandbox) — using rounded-up strike");
    const fallback = calls.find((o) => o.strike === targetStrike) ||
      calls.reduce((prev, curr) =>
        Math.abs(curr.strike - targetStrike) < Math.abs(prev.strike - targetStrike) ? curr : prev
      );
    return { symbol: fallback.symbol, strike: fallback.strike, ask: fallback.ask, delta: "N/A" };
  }

  const closest = withDelta.reduce((prev, curr) =>
    Math.abs((curr.greeks?.delta || 0) - DELTA_TARGET) <
    Math.abs((prev.greeks?.delta || 0) - DELTA_TARGET) ? curr : prev
  );
  console.log(`✓ Fallback delta: strike $${closest.strike} | delta ${closest.greeks?.delta}`);
  return { symbol: closest.symbol, strike: closest.strike, ask: closest.ask, delta: closest.greeks?.delta };
}

async function hasOpenPosition() {
  if (activeTrade) return true;
  const data = await tradierRequest("GET", `/accounts/${ACCOUNT_ID}/positions`);
  const positions = data?.positions?.position;
  if (!positions) return false;
  const posArray = Array.isArray(positions) ? positions : [positions];
  return posArray.some((p) => p.symbol.startsWith("SPY") && p.quantity > 0);
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
    console.log(`Cancelled order ${orderId}`);
  } catch (e) {
    console.log(`Could not cancel order ${orderId}:`, e.message);
  }
}

async function isOrderFilled(orderId) {
  try {
    const data = await tradierRequest("GET", `/accounts/${ACCOUNT_ID}/orders/${orderId}`);
    return data?.order?.status === "filled";
  } catch (e) {
    return false;
  }
}

async function monitorRunners(optionSymbol, runnerQty, entryPrice, runnerLimitOrderId, stopTimeMs) {
  console.log(`\n🏃 Runner monitor started: ${runnerQty} contracts`);
  console.log(`   Entry: $${entryPrice} | Target: $${(entryPrice * (1 + RUNNER_PCT)).toFixed(2)} | Trailing stop: 10% from peak`);

  let peakPrice     = entryPrice;
  const targetPrice = parseFloat((entryPrice * (1 + RUNNER_PCT)).toFixed(2));

  const interval = setInterval(async () => {
    try {
      if (Date.now() >= stopTimeMs) {
        console.log("⏰ 30-min stop — closing runners at market");
        clearInterval(interval);
        await cancelOrder(runnerLimitOrderId);
        await placeOrder(optionSymbol, "sell_to_close", runnerQty, "market");
        activeTrade = null;
        return;
      }

      if (await isOrderFilled(runnerLimitOrderId)) {
        console.log(`✅ Runner target hit at $${targetPrice}`);
        clearInterval(interval);
        activeTrade = null;
        return;
      }

      const currentPrice = await getOptionPrice(optionSymbol);
      if (!currentPrice || currentPrice <= 0) return;

      if (currentPrice > peakPrice) {
        peakPrice = currentPrice;
        console.log(`📈 New peak: $${peakPrice.toFixed(2)}`);
      }

      const trailingStopPrice = parseFloat((peakPrice * (1 - TRAILING_STOP)).toFixed(2));
      if (currentPrice <= trailingStopPrice) {
        console.log(`🛑 Trailing stop hit — current $${currentPrice} <= stop $${trailingStopPrice} (peak $${peakPrice})`);
        clearInterval(interval);
        await cancelOrder(runnerLimitOrderId);
        await placeOrder(optionSymbol, "sell_to_close", runnerQty, "market");
        activeTrade = null;
        return;
      }

      console.log(`👀 Runners: $${currentPrice.toFixed(2)} | peak $${peakPrice.toFixed(2)} | stop $${trailingStopPrice.toFixed(2)} | target $${targetPrice}`);

    } catch (e) {
      console.log("Runner monitor error:", e.message);
    }
  }, 15000);
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
    // 1. Check kill switches
    if (botPaused) {
      console.log("⛔ Bot is PAUSED — skipping signal");
      return res.json({ status: "skipped", reason: "Bot paused" });
    }

    if (skipNext) {
      skipNext = false;  // auto-reset after one skip
      console.log("⏭️  Skipping this signal (skip-next was set) — bot now resumed");
      return res.json({ status: "skipped", reason: "Skip next was set — bot now resumed" });
    }

    // 2. Check trading window
    if (!isInTradingWindow()) {
      const { hour, minute } = getETTime();
      console.log(`Outside window at ${hour}:${String(minute).padStart(2, "0")} ET. Skipping.`);
      return res.json({ status: "skipped", reason: "Outside trading window" });
    }
    console.log("✓ Within trading window (10:35 AM – 3:05 PM ET)");

    // 3. Check for existing position
    if (await hasOpenPosition()) {
      console.log("Already in a trade. Skipping.");
      return res.json({ status: "skipped", reason: "Already in trade" });
    }
    console.log("✓ No existing position");

    // 4. Get SPY price
    const spyPrice = await getSPYPrice();
    console.log(`✓ SPY price: $${spyPrice}`);

    // 5. Find best call option
    const { symbol: optionSymbol, strike, ask, delta } = await getBestCallOption(spyPrice);
    console.log(`✓ Selected: ${optionSymbol} | Strike: $${strike} | Ask: $${ask} | Delta: ${delta}`);

    // 6. Place buy order
    const buyOrder  = await placeOrder(optionSymbol, "buy_to_open", CONTRACTS, "market");
    const filledQty = buyOrder?.quantity || CONTRACTS;
    console.log(`✓ Buy order: ID ${buyOrder?.id} | Qty: ${filledQty}`);

    const entryPrice = ask || 1.00;

    // 7. Calculate 75/25 split
    const { firstExit, runners } = calcSplit(filledQty);
    console.log(`✓ Split: ${firstExit} @ +8% | ${runners} runners`);

    // 8. First exit limit order
    const firstExitPrice = parseFloat((entryPrice * (1 + PROFIT_PCT)).toFixed(2));
    const firstExitOrder = await placeOrder(optionSymbol, "sell_to_close", firstExit, "limit", firstExitPrice);
    console.log(`✓ First exit: ${firstExit} contracts @ $${firstExitPrice} | ID ${firstExitOrder?.id}`);

    // 9. Runner limit order
    const runnerTargetPrice = parseFloat((entryPrice * (1 + RUNNER_PCT)).toFixed(2));
    const runnerLimitOrder  = await placeOrder(optionSymbol, "sell_to_close", runners, "limit", runnerTargetPrice);
    console.log(`✓ Runner limit: ${runners} contracts @ $${runnerTargetPrice} | ID ${runnerLimitOrder?.id}`);

    // 10. Store active trade
    const stopTimeMs = Date.now() + TIME_STOP_MIN * 60 * 1000;
    activeTrade = { optionSymbol, entryPrice, filledQty, firstExit, runners, openedAt: Date.now() };

    // 11. 30-min hard stop for first exit contracts
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

    // 12. Runner monitor
    if (runners > 0) {
      monitorRunners(optionSymbol, runners, entryPrice, runnerLimitOrder?.id, stopTimeMs);
    }

    console.log(`✅ Webhook processed in ${Date.now() - startTime}ms`);

    return res.json({
      status: "trade opened",
      mode: LIVE_MODE ? "LIVE" : "SANDBOX",
      strikeMode: isDeltaPriorityMode() ? "delta priority" : "strike first",
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
    status: botPaused ? "PAUSED" : skipNext ? "SKIP_NEXT" : "running",
    mode: LIVE_MODE ? "LIVE" : "SANDBOX",
    activeTrade: activeTrade || "none",
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SPY Green Star bot running on port ${PORT}`);
  console.log(`Mode: ${LIVE_MODE ? "🔴 LIVE" : "🟡 SANDBOX (paper)"}`);
  console.log(`Window: 10:35 AM – 3:05 PM ET`);
  console.log(`Before 1 PM: Strike first | After 1 PM: Delta priority`);
  console.log(`Contracts: ${CONTRACTS} | Split: 75% @ +8% / 25% runners @ +20% or 10% trailing`);
  console.log(`Time stop: ${TIME_STOP_MIN} min hard close all contracts`);
  console.log(`Kill switches: /pause /resume /skip /status`);
});
