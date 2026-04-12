// ============================================================
//  SPY GREEN STAR AUTO TRADER — Render.com Web Service
//  Rules:
//  - Time window  : 10:45 AM – 3:00 PM ET
//  - Strike       : Round UP to nearest whole dollar (true ATM)
//  - No delta filtering
//  - Contracts    : 100
//  - Exit 1       : 75 contracts at +8% (limit order)
//  - Runners      : 25 contracts split into 3 tiers:
//      Tier 1: 17 contracts at +15%
//      Tier 2: 4 contracts at +20%
//      Tier 3: 4 contracts — trailing stop only, floor at breakeven
//  - Trailing stop: 10% from peak, activates AFTER first exit fills at +8%
//  - Time stop    : 30 minutes — closes ALL remaining contracts
//
//  CONTROLS (bookmark on phone):
//  GET /pause      — pause bot
//  GET /resume     — resume bot
//  GET /skip       — skip next signal only
//  GET /earlybird  — bypass time window for next signal only
//  GET /breakeven  — limit sell ALL remaining contracts at entry price
//  GET /emergency  — market sell ALL remaining contracts immediately
//  GET /status     — check bot state
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
const TIER1_PCT     = 0.15;
const TIER2_PCT     = 0.20;
const TRAILING_STOP = 0.10;
const TIME_STOP_MIN = 30;

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

// ─── BOT STATE ────────────────────────────────────────────────
let activeTrade = null;  // stores full trade details including entry price and open order IDs
let botPaused   = false;
let skipNext    = false;
let earlyBird   = false;

console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET] Server starting...`);

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
  const tier1     = Math.floor(runners * (17 / 25));
  const tier2     = Math.floor((runners - tier1) / 2);
  const tier3     = runners - tier1 - tier2;
  return { firstExit, runners, tier1, tier2, tier3 };
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

  const above = calls.filter((o) => o.strike > spyPrice).sort((a, b) => a.strike - b.strike);
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

// Cancel all open orders and close all positions
async function closeAllPositions(type, price = null) {
  if (!activeTrade) return { message: "No active trade to close" };

  const { optionSymbol, entryPrice, openOrderIds, filledQty } = activeTrade;

  // Cancel all open orders
  if (openOrderIds && openOrderIds.length > 0) {
    for (const orderId of openOrderIds) {
      await cancelOrder(orderId);
    }
  }

  // Get current open position quantity from Tradier
  let qty = filledQty;
  try {
    const data = await tradierRequest("GET", `/accounts/${ACCOUNT_ID}/positions`);
    const positions = data?.positions?.position;
    if (positions) {
      const posArray = Array.isArray(positions) ? positions : [positions];
      const spyPos = posArray.find((p) => p.symbol === optionSymbol && p.quantity > 0);
      if (spyPos) qty = spyPos.quantity;
    }
  } catch (e) {
    console.log("Could not fetch position qty, using filledQty:", e.message);
  }

  if (qty <= 0) {
    activeTrade = null;
    return { message: "No open position found" };
  }

  // Place the closing order
  const closePrice = type === "limit" ? (price || entryPrice) : null;
  const closeOrder = await placeOrder(optionSymbol, "sell_to_close", qty, type, closePrice);
  activeTrade = null;

  return {
    message: `Closed ${qty} contracts`,
    type,
    price: closePrice || "market",
    orderId: closeOrder?.id,
  };
}

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
  res.json({ status: 'skip_set', message: 'Next signal will be skipped. Auto-resumes after.' });
});

app.get('/earlybird', (req, res) => {
  if (botPaused) return res.json({ status: 'error', message: 'Bot is paused. Hit /resume first.' });
  earlyBird = true;
  console.log('🐦 EARLYBIRD active — next signal bypasses time window');
  res.json({ status: 'earlybird_set', message: 'Time window bypassed for next signal only. Auto-resets after.' });
});

// Limit sell all remaining contracts at entry price (breakeven)
app.get('/breakeven', async (req, res) => {
  console.log('💰 BREAKEVEN triggered — limit sell all contracts at entry price');
  if (!activeTrade) {
    return res.json({ status: 'error', message: 'No active trade to close' });
  }
  try {
    const result = await closeAllPositions("limit", activeTrade.entryPrice);
    console.log(`Breakeven close: ${JSON.stringify(result)}`);
    res.json({ status: 'breakeven_placed', entryPrice: activeTrade.entryPrice, ...result });
  } catch (e) {
    console.error('Breakeven error:', e.message);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// Market sell all remaining contracts immediately (emergency)
app.get('/emergency', async (req, res) => {
  console.log('🚨 EMERGENCY triggered — market sell ALL contracts NOW');
  if (!activeTrade) {
    return res.json({ status: 'error', message: 'No active trade to close' });
  }
  try {
    const result = await closeAllPositions("market");
    console.log(`Emergency close: ${JSON.stringify(result)}`);
    res.json({ status: 'emergency_closed', ...result });
  } catch (e) {
    console.error('Emergency error:', e.message);
    res.status(500).json({ status: 'error', message: e.message });
  }
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

// ─── RUNNER MONITOR ───────────────────────────────────────────
async function monitorRunners(
  optionSymbol, entryPrice, firstExitOrderId,
  tier1Qty, tier1OrderId,
  tier2Qty, tier2OrderId,
  tier3Qty, tier3OrderId,
  stopTimeMs
) {
  console.log(`\n🏃 Runner monitor started`);
  console.log(`   Tier 1: ${tier1Qty} @ +15% | Tier 2: ${tier2Qty} @ +20% | Tier 3: ${tier3Qty} free`);
  console.log(`   Trailing stop (10%) activates after first exit fills at +8%`);

  let peakPrice          = entryPrice;
  let trailingStopActive = false;

  const interval = setInterval(async () => {
    try {
      // Hard time stop
      if (Date.now() >= stopTimeMs) {
        console.log("⏰ 30-min stop — closing all remaining runners");
        clearInterval(interval);
        for (const [orderId, qty, label] of [
          [tier1OrderId, tier1Qty, "Tier 1"],
          [tier2OrderId, tier2Qty, "Tier 2"],
          [tier3OrderId, tier3Qty, "Tier 3"],
        ]) {
          if (!(await isOrderFilled(orderId))) {
            await cancelOrder(orderId);
            await placeOrder(optionSymbol, "sell_to_close", qty, "market");
            console.log(`Closed ${label} (${qty} contracts) at market`);
          }
        }
        if (activeTrade) activeTrade = null;
        return;
      }

      // Check if activeTrade was cleared by emergency/breakeven
      if (!activeTrade) {
        console.log("Trade cleared externally — stopping runner monitor");
        clearInterval(interval);
        return;
      }

      // Wait for first exit to fill
      if (!trailingStopActive) {
        if (await isOrderFilled(firstExitOrderId)) {
          trailingStopActive = true;
          console.log(`✅ First exit filled — trailing stop NOW ACTIVE`);
        } else {
          console.log(`⏳ Waiting for first exit (+8%) to fill...`);
          return;
        }
      }

      // Current price
      const currentPrice = await getOptionPrice(optionSymbol);
      if (!currentPrice || currentPrice <= 0) return;

      // Update peak
      if (currentPrice > peakPrice) {
        peakPrice = currentPrice;
        console.log(`📈 New peak: $${peakPrice.toFixed(2)}`);
      }

      // Check tiers filled
      const tier1Filled = await isOrderFilled(tier1OrderId);
      const tier2Filled = await isOrderFilled(tier2OrderId);
      const tier3Filled = await isOrderFilled(tier3OrderId);

      if (tier1Filled && tier2Filled && tier3Filled) {
        console.log(`✅ All runner tiers filled`);
        clearInterval(interval);
        activeTrade = null;
        return;
      }

      // Trailing stop
      const trailingStopPrice = parseFloat((peakPrice * (1 - TRAILING_STOP)).toFixed(2));
      if (currentPrice <= trailingStopPrice) {
        console.log(`🛑 Trailing stop hit — current $${currentPrice} <= stop $${trailingStopPrice}`);
        clearInterval(interval);
        for (const [orderId, qty, label] of [
          [tier1OrderId, tier1Qty, "Tier 1"],
          [tier2OrderId, tier2Qty, "Tier 2"],
          [tier3OrderId, tier3Qty, "Tier 3"],
        ]) {
          if (!(await isOrderFilled(orderId))) {
            await cancelOrder(orderId);
            await placeOrder(optionSymbol, "sell_to_close", qty, "market");
            console.log(`Closed ${label} via trailing stop`);
          }
        }
        activeTrade = null;
        return;
      }

      // Tier 3 breakeven floor
      if (!tier3Filled && currentPrice <= entryPrice) {
        console.log(`🔒 Tier 3 breakeven floor — closing ${tier3Qty} contracts at market`);
        await cancelOrder(tier3OrderId);
        await placeOrder(optionSymbol, "sell_to_close", tier3Qty, "market");
      }

      console.log(`👀 $${currentPrice.toFixed(2)} | peak $${peakPrice.toFixed(2)} | stop $${trailingStopPrice.toFixed(2)} | T1:${tier1Filled ? '✅' : '⏳'} T2:${tier2Filled ? '✅' : '⏳'} T3:${tier3Filled ? '✅' : '⏳'}`);

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
    // Kill switches
    if (botPaused) {
      console.log("⛔ Bot PAUSED");
      return res.json({ status: "skipped", reason: "Bot paused" });
    }
    if (skipNext) {
      skipNext = false;
      console.log("⏭️  Skip next triggered");
      return res.json({ status: "skipped", reason: "Skip next was set — bot now resumed" });
    }

    // Time window
    if (earlyBird) {
      earlyBird = false;
      console.log("🐦 EARLYBIRD — time window bypassed");
    } else if (!isInTradingWindow()) {
      const { hour, minute } = getETTime();
      console.log(`Outside window at ${hour}:${String(minute).padStart(2, "0")} ET`);
      return res.json({ status: "skipped", reason: "Outside trading window" });
    } else {
      console.log("✓ Within trading window (10:45 AM – 3:00 PM ET)");
    }

    // Existing position
    if (await hasOpenPosition()) {
      console.log("Already in a trade. Skipping.");
      return res.json({ status: "skipped", reason: "Already in trade" });
    }
    console.log("✓ No existing position");

    // SPY price
    const spyPrice = await getSPYPrice();
    console.log(`✓ SPY price: $${spyPrice}`);

    // ATM call
    const { symbol: optionSymbol, strike, ask } = await getATMCallOption(spyPrice);
    console.log(`✓ Selected: ${optionSymbol} | Strike: $${strike} | Ask: $${ask}`);

    // Buy order
    const buyOrder  = await placeOrder(optionSymbol, "buy_to_open", CONTRACTS, "market");
    const filledQty = buyOrder?.quantity || CONTRACTS;
    console.log(`✓ Buy order: ID ${buyOrder?.id} | Qty: ${filledQty}`);

    const entryPrice = ask || 1.00;

    // Splits
    const { firstExit, runners, tier1, tier2, tier3 } = calcSplit(filledQty);
    console.log(`✓ Split: ${firstExit} @ +8% | ${tier1} @ +15% | ${tier2} @ +20% | ${tier3} free`);

    // Orders
    const firstExitPrice = parseFloat((entryPrice * (1 + PROFIT_PCT)).toFixed(2));
    const firstExitOrder = await placeOrder(optionSymbol, "sell_to_close", firstExit, "limit", firstExitPrice);
    console.log(`✓ First exit: ${firstExit} @ $${firstExitPrice} | ID ${firstExitOrder?.id}`);

    const tier1Price = parseFloat((entryPrice * (1 + TIER1_PCT)).toFixed(2));
    const tier1Order = await placeOrder(optionSymbol, "sell_to_close", tier1, "limit", tier1Price);
    console.log(`✓ Tier 1: ${tier1} @ $${tier1Price} | ID ${tier1Order?.id}`);

    const tier2Price = parseFloat((entryPrice * (1 + TIER2_PCT)).toFixed(2));
    const tier2Order = await placeOrder(optionSymbol, "sell_to_close", tier2, "limit", tier2Price);
    console.log(`✓ Tier 2: ${tier2} @ $${tier2Price} | ID ${tier2Order?.id}`);

    const tier3Price = parseFloat((entryPrice * 5).toFixed(2));
    const tier3Order = await placeOrder(optionSymbol, "sell_to_close", tier3, "limit", tier3Price);
    console.log(`✓ Tier 3: ${tier3} free runners | ID ${tier3Order?.id}`);

    // Store active trade with all order IDs for emergency/breakeven
    const stopTimeMs = Date.now() + TIME_STOP_MIN * 60 * 1000;
    activeTrade = {
      optionSymbol,
      entryPrice,
      filledQty,
      openedAt: Date.now(),
      openOrderIds: [
        firstExitOrder?.id,
        tier1Order?.id,
        tier2Order?.id,
        tier3Order?.id,
      ].filter(Boolean),
    };

    // 30-min hard stop for first exit
    setTimeout(async () => {
      console.log("\n=== 30-MIN TIME STOP — FIRST EXIT ===");
      if (!(await isOrderFilled(firstExitOrder?.id))) {
        await cancelOrder(firstExitOrder?.id);
        await placeOrder(optionSymbol, "sell_to_close", firstExit, "market");
        console.log(`Closed ${firstExit} first-exit contracts at market`);
      } else {
        console.log(`First exit already filled`);
      }
      if (activeTrade) activeTrade = null;
    }, TIME_STOP_MIN * 60 * 1000);

    // Runner monitor
    monitorRunners(
      optionSymbol, entryPrice, firstExitOrder?.id,
      tier1, tier1Order?.id,
      tier2, tier2Order?.id,
      tier3, tier3Order?.id,
      stopTimeMs
    );

    console.log(`✅ Webhook processed in ${Date.now() - startTime}ms`);

    return res.json({
      status: "trade opened",
      mode: LIVE_MODE ? "LIVE" : "SANDBOX",
      spyPrice,
      strike,
      optionSymbol,
      entryPrice,
      filledQty,
      firstExit: { contracts: firstExit, target: `+8% @ $${firstExitPrice}` },
      tier1: { contracts: tier1, target: `+15% @ $${tier1Price}` },
      tier2: { contracts: tier2, target: `+20% @ $${tier2Price}` },
      tier3: { contracts: tier3, target: "trailing stop + breakeven floor" },
      timeStopMinutes: TIME_STOP_MIN,
      buyOrderId: buyOrder?.id,
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
  console.log(`Window: 10:45 AM – 3:00 PM ET`);
  console.log(`Contracts: ${CONTRACTS} | First exit: 75 @ +8%`);
  console.log(`Runners: 17 @ +15% / 4 @ +20% / 4 free (trailing stop + breakeven floor)`);
  console.log(`Trailing stop: 10% from peak, activates after first exit fills`);
  console.log(`Time stop: ${TIME_STOP_MIN} min hard close all`);
  console.log(`Controls: /pause /resume /skip /earlybird /breakeven /emergency /status`);
});
