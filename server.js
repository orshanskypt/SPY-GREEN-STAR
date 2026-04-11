// ============================================================
//  SPY GREEN STAR AUTO TRADER — Render.com Web Service
//  Rules:
//  - Time window  : 10:35 AM – 3:05 PM ET
//  - Strike       : Round UP to nearest whole dollar (true ATM)
//  - No delta filtering
//  - Contracts    : 100 (paper trading)
//  - Exit 1       : 75% of filled contracts at +8% (limit order)
//  - Exit 2       : 25% runners — +20% target OR 10% trailing stop from peak
//                   Trailing stop ONLY activates after first exit fills at +8%
//  - Time stop    : 30 minutes — closes ALL remaining contracts
//
//  KILL SWITCH URLS (bookmark on your phone):
//  GET /pause      — pause bot, skip all signals until resumed
//  GET /resume     — resume bot
//  GET /skip       — skip the very next signal only, then auto-resume
//  GET /earlybird  — bypass time window for next signal only, then auto-resets
//  GET /status     — check current bot state
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
const CONTRACTS     = 100;
const PROFIT_PCT    = 0.08;
const RUNNER_PCT    = 0.20;
const TRAILING_STOP = 0.10;
const TIME_STOP_MIN = 30;

const MARKET_OPEN_HOUR  = 10;
const MARKET_OPEN_MIN   = 35;
const MARKET_CLOSE_HOUR = 15;
const MARKET_CLOSE_MIN  = 5;

const TRADIER_SANDBOX_BASE = "https://sandbox.tradier.com/v1";
const TRADIER_LIVE_BASE    = "https://api.tradier.com/v1";
const BASE_URL   = LIVE_MODE ? TRADIER_LIVE_BASE    : TRADIER_SANDBOX_BASE;
const API_TOKEN  = LIVE_MODE ? process.env.TRADIER_LIVE_TOKEN : process.env.TRADIER_SANDBOX_TOKEN;
const ACCOUNT_ID = process.env.TRADIER_ACCOUNT_ID;
// ─────────────────────────────────────────────────────────────

// ─── BOT STATE ────────────────────────────────────────────────
let activeTrade  = null;
let botPaused    = false;
let skipNext     = false;
let earlyBird    = false;   // bypass time window for next signal only

console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET] Server starting...`);

// ─── CONTROL ENDPOINTS ────────────────────────────────────────
app.get('/pause', (req, res) => {
  botPaused = true;
  skipNext  = false;
  earlyBird = false;
  console.log('⛔ Bot PAUSED');
  res.json({ status: 'paused', message: 'Bot paused. Hit /resume to re-enable.' });
});

app.get('/resume', (req, res) => {
  botPaused = false;
  skipNext  = false;
  earlyBird = false;
  console.log('✅ Bot RESUMED');
  res.json({ status: 'resumed', message: 'Bot resumed. Signals active.' });
});

app.get('/skip', (req, res) => {
  skipNext = true;
  console.log('⏭️  Skip next signal set');
  res.json({ status: 'skip_set', message: 'Next signal will be skipped. Bot auto-resumes after.' });
});

app.get('/earlybird', (req, res) => {
  if (botPaused) {
    return res.json({ status: 'error', message: 'Bot is paused. Hit /resume first.' });
  }
  earlyBird = true;
  console.log('🐦 EARLYBIRD active — next signal will bypass time window');
  res.json({ status: 'earlybird_set', message: 'Time window bypassed for next signal only. Auto-resets after trade.' });
});

app.get('/status', (req, res) => {
  res.json({
    status: botPaused ? 'PAUSED' : skipNext ? 'SKIP_NEXT' : earlyBird ? 'EARLYBIRD' : 'ACTIVE',
    botPaused,
    skipNext,
    earlyBird,
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

async function getATMCallOption(spyPrice) {
  const { dateStr } = getETTime();
  const targetStrike = roundUpStrike(spyPrice);
  console.log(`SPY price: $${spyPrice} → Target strike: $${targetStrike}`);

  const data = await tradierRequest(
    "GET",
    `/markets/options/chains?symbol=SPY&expiration=${dateStr}&greeks=false`
  );

  const options = data?.options?.option;
  if (!options || options.length === 0) throw new Error(`No options found for SPY expiration ${dateStr}`);

  const calls = options.filter((o) => o.option_type === "call");
  if (calls.length === 0) throw new Error("No call options found for today");

  const exact = calls.find((o) => o.strike === targetStrike);
  if (exact) {
    console.log(`✓ ATM call: ${exact.symbol} | Strike: $${exact.strike} | Ask: $${exact.ask}`);
    return { symbol: exact.symbol, strike: exact.strike, ask: exact.ask };
  }

  const above = calls
    .filter((o) => o.strike > spyPrice)
    .sort((a, b) => a.strike - b.strike);

  if (above.length > 0) {
    const closest = above[0];
    console.log(`✓ Closest above: ${closest.symbol} | Strike: $${closest.strike} | Ask: $${closest.ask}`);
    return { symbol: closest.symbol, strike: closest.strike, ask: closest.ask };
  }

  throw new Error("Could not find a valid call option");
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

async function monitorRunners(optionSymbol, runnerQty, entryPrice, firstExitOrderId, runnerLimitOrderId, stopTimeMs) {
  console.log(`\n🏃 Runner monitor started: ${runnerQty} contracts`);
  console.log(`   Entry: $${entryPrice} | Runner target: $${(entryPrice * (1 + RUNNER_PCT)).toFixed(2)}`);
  console.log(`   Trailing stop (10%) activates AFTER first exit fills at +8%`);

  let peakPrice          = entryPrice;
  let trailingStopActive = false;
  const runnerTarget     = parseFloat((entryPrice * (1 + RUNNER_PCT)).toFixed(2));

  const interval = setInterval(async () => {
    try {
      // Hard time stop
      if (Date.now() >= stopTimeMs) {
        console.log("⏰ 30-min stop — closing runners at market");
        clearInterval(interval);
        await cancelOrder(runnerLimitOrderId);
        await placeOrder(optionSymbol, "sell_to_close", runnerQty, "market");
        activeTrade = null;
        return;
      }

      // Check if runner limit already filled
      if (await isOrderFilled(runnerLimitOrderId)) {
        console.log(`✅ Runner target hit at $${runnerTarget}`);
        clearInterval(interval);
        activeTrade = null;
        return;
      }

      // Wait for first exit to fill before activating trailing stop
      if (!trailingStopActive) {
        const firstFilled = await isOrderFilled(firstExitOrderId);
        if (firstFilled) {
          trailingStopActive = true;
          console.log(`✅ First exit confirmed filled — trailing stop NOW ACTIVE on ${runnerQty} runners`);
        } else {
          console.log(`⏳ Waiting for first exit to fill before trailing stop activates...`);
          return;
        }
      }

      // Get current price
      const currentPrice = await getOptionPrice(optionSymbol);
      if (!currentPrice || currentPrice <= 0) return;

      // Update peak
      if (currentPrice > peakPrice) {
        peakPrice = currentPrice;
        console.log(`📈 New peak: $${peakPrice.toFixed(2)}`);
      }

      // Trailing stop check
      const trailingStopPrice = parseFloat((peakPrice * (1 - TRAILING_STOP)).toFixed(2));
      if (currentPrice <= trailingStopPrice) {
        console.log(`🛑 Trailing stop hit — current $${currentPrice} <= stop $${trailingStopPrice} (peak $${peakPrice})`);
        clearInterval(interval);
        await cancelOrder(runnerLimitOrderId);
        await placeOrder(optionSymbol, "sell_to_close", runnerQty, "market");
        activeTrade = null;
        return;
      }

      console.log(`👀 Runners: $${currentPrice.toFixed(2)} | peak $${peakPrice.toFixed(2)} | stop $${trailingStopPrice.toFixed(2)} | target $${runnerTarget}`);

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
    // 1. Kill switches
    if (botPaused) {
      console.log("⛔ Bot is PAUSED — skipping signal");
      return res.json({ status: "skipped", reason: "Bot paused" });
    }

    if (skipNext) {
      skipNext = false;
      console.log("⏭️  Skipping this signal (skip-next was set) — bot now resumed");
      return res.json({ status: "skipped", reason: "Skip next was set — bot now resumed" });
    }

    // 2. Trading window check (bypassed if earlybird is set)
    if (earlyBird) {
      earlyBird = false; // auto-reset after one use
      console.log("🐦 EARLYBIRD — time window bypassed for this signal");
    } else if (!isInTradingWindow()) {
      const { hour, minute } = getETTime();
      console.log(`Outside window at ${hour}:${String(minute).padStart(2, "0")} ET. Skipping.`);
      return res.json({ status: "skipped", reason: "Outside trading window" });
    } else {
      console.log("✓ Within trading window (10:35 AM – 3:05 PM ET)");
    }

    // 3. Existing position check
    if (await hasOpenPosition()) {
      console.log("Already in a trade. Skipping.");
      return res.json({ status: "skipped", reason: "Already in trade" });
    }
    console.log("✓ No existing position");

    // 4. SPY price
    const spyPrice = await getSPYPrice();
    console.log(`✓ SPY price: $${spyPrice}`);

    // 5. Get ATM call
    const { symbol: optionSymbol, strike, ask } = await getATMCallOption(spyPrice);
    console.log(`✓ Selected: ${optionSymbol} | Strike: $${strike} | Ask: $${ask}`);

    // 6. Buy order
    const buyOrder  = await placeOrder(optionSymbol, "buy_to_open", CONTRACTS, "market");
    const filledQty = buyOrder?.quantity || CONTRACTS;
    console.log(`✓ Buy order: ID ${buyOrder?.id} | Qty: ${filledQty}`);

    const entryPrice = ask || 1.00;

    // 7. 75/25 split
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

    // 11. 30-min hard stop
    setTimeout(async () => {
      console.log("\n=== 30-MIN TIME STOP ===");
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
      monitorRunners(optionSymbol, runners, entryPrice, firstExitOrder?.id, runnerLimitOrder?.id, stopTimeMs);
    }

    console.log(`✅ Webhook processed in ${Date.now() - startTime}ms`);

    return res.json({
      status: "trade opened",
      mode: LIVE_MODE ? "LIVE" : "SANDBOX",
      spyPrice,
      strike,
      optionSymbol,
      entryPrice,
      filledQty,
      firstExitContracts: firstExit,
      firstExitPrice,
      runnerContracts: runners,
      runnerTargetPrice,
      trailingStopNote: "10% trailing stop activates only after first exit fills at +8%",
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
    status: botPaused ? "PAUSED" : skipNext ? "SKIP_NEXT" : earlyBird ? "EARLYBIRD" : "running",
    mode: LIVE_MODE ? "LIVE" : "SANDBOX",
    activeTrade: activeTrade || "none",
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SPY Green Star bot running on port ${PORT}`);
  console.log(`Mode: ${LIVE_MODE ? "🔴 LIVE" : "🟡 SANDBOX (paper)"}`);
  console.log(`Window: 10:35 AM – 3:05 PM ET`);
  console.log(`Strike: Round UP to nearest whole dollar | No delta filtering`);
  console.log(`Contracts: ${CONTRACTS} | Split: 75% @ +8% / 25% runners @ +20% or 10% trailing`);
  console.log(`Trailing stop: activates ONLY after first exit fills at +8%`);
  console.log(`Time stop: ${TIME_STOP_MIN} min hard close all contracts`);
  console.log(`Controls: /pause /resume /skip /earlybird /status`);
});
