import express from "express";
import fetch from "node-fetch";
const app = express();
app.use(express.json());
// === HEALTH ===
app.get('/ping', (req, res) => res.send('OK'));
app.get('/healthz', (req, res) => res.send('OK'));
// ─── CONFIG ─────────────────────────────────────
const LIVE_MODE = process.env.LIVE_MODE === "true";
const MAX_CONTRACTS = 6;            // hard ceiling per trade
const MIN_CONTRACTS = 1;            // must afford at least 1 or skip
const BP_BUFFER_PCT = 0.02;         // leave 2% headroom so a small fill drift doesn't reject
const PROFIT_PCT = 0.08;            // core profit target
const TIME_STOP_MIN = 30;
const SELL_POLL_INTERVAL_MS = 10000;
// ── Runner config (true trailing runner) ──
const RUNNER_ENABLED      = true;
const RUNNER_MIN_QTY      = 2;
const RUNNER_GIVEBACK_PCT = 0.40;   // stop = entry + gain×(1−this); floored at entry
// ── Mid tier config ──
const MID_ENABLED    = true;
const MID_MIN_QTY    = 6;
const MID_TARGET_PCT = 0.12;        // mid limit-sell target (+12%)
const MID_STOP_PCT   = 0.08;        // mid virtual stop, activated AFTER core fills
// ── EOD failsafe ──
// 0DTE protection: when mid/runner are riding (no time limit), force-close any open legs
// at this ET time so they don't expire worthless. Set well before 4:00 PM SPY settle.
const EOD_FAILSAFE_HHMM_ET = [15, 50]; // 3:50 PM ET
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
let earlyBirdTimer = null;    // auto-expires the earlyBird flag
let tradingLock = false;      // synchronous lock: prevents concurrent openTrade() calls
const EARLYBIRD_TTL_MIN = 90; // earlyBird auto-clears after this many minutes if no signal
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
// ms remaining until the EOD failsafe time today, or 0 if we've already passed it.
function msUntilEodEt() {
  const { hour, minute } = getETTime();
  const nowMins    = hour * 60 + minute;
  const targetMins = EOD_FAILSAFE_HHMM_ET[0] * 60 + EOD_FAILSAFE_HHMM_ET[1];
  if (nowMins >= targetMins) return 0;
  return (targetMins - nowMins) * 60_000;
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
// Quote helper used by the runner-trailing logic. Tries `last`, then mid of bid/ask.
async function getOptionPrice(symbol) {
  const data = await tradierRequest("GET", `/markets/quotes?symbols=${encodeURIComponent(symbol)}`);
  const q = data?.quotes?.quote;
  if (!q) throw new Error(`No quote for ${symbol}`);
  const last = parseFloat(q.last);
  if (Number.isFinite(last) && last > 0) return last;
  const bid = parseFloat(q.bid);
  const ask = parseFloat(q.ask);
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
    return (bid + ask) / 2;
  }
  throw new Error(`Unusable quote for ${symbol}: ${JSON.stringify(q)}`);
}
// ─── TRADE OPENER (shared by /webhook and /fire) ───
// If `requestedQty` is null/undefined → auto-size from buying power, capped at MAX_CONTRACTS.
// If `requestedQty` is a number → use exactly that many contracts, but still verify BP can cover it.
// Returns { skipped: true, reason } if we can't afford the trade.
//
// 🔒 SYNCHRONOUS LOCK: set immediately to prevent a second concurrent caller from
// passing the activeTrade check while we're awaiting on Tradier (e.g. /fire2 double-click).
async function openTrade(requestedQty = null) {
  if (tradingLock) {
    return { skipped: true, reason: "trade already in progress (lock held)" };
  }
  tradingLock = true;
  // 🐦 Any successful entry path consumes earlyBird — covers /webhook AND /fire.
  if (earlyBird) {
    earlyBird = false;
    if (earlyBirdTimer) { clearTimeout(earlyBirdTimer); earlyBirdTimer = null; }
    console.log("🐦 earlyBird consumed and reset");
  }
  try {
  const spy = await getSPYPrice();
  console.log("SPY price:", spy);
  const option = await getATMCall(spy);
  console.log("Option selected:", option.symbol);
  const bp  = await getOptionBuyingPower();
  const ask = parseFloat(option.ask);
  let qty;
  if (requestedQty == null) {
    // 💰 Auto-size
    qty = calcContracts(ask, bp);
    console.log(`💵 BP: $${bp.toFixed(2)}  |  ask: $${ask}  |  auto-sized qty: ${qty} (max ${MAX_CONTRACTS})`);
  } else {
    // 🎯 Explicit qty — but still BP-check it
    const affordable = calcContracts(ask, bp);
    if (requestedQty > MAX_CONTRACTS) {
      const reason = `Requested ${requestedQty} exceeds MAX_CONTRACTS (${MAX_CONTRACTS})`;
      console.log("⛔", reason);
      return { skipped: true, reason, bp, ask, requestedQty };
    }
    if (requestedQty > affordable) {
      const reason = `Requested ${requestedQty} contracts but BP only supports ${affordable} (BP $${bp.toFixed(2)}, ask $${ask})`;
      console.log("⛔", reason);
      return { skipped: true, reason, bp, ask, requestedQty, affordable };
    }
    qty = requestedQty;
    console.log(`💵 BP: $${bp.toFixed(2)}  |  ask: $${ask}  |  explicit qty: ${qty}`);
  }
  if (qty === 0) {
    const reason = `Insufficient buying power: $${bp.toFixed(2)} available, need $${(ask * 100).toFixed(2)} for 1 contract`;
    console.log("⛔", reason);
    return { skipped: true, reason, bp, ask };
  }
  // 🟢 Buy (single market order for the full qty)
  const buy = await placeOrder(option.symbol, "buy_to_open", qty, "market");
  const fill = await getFillPrice(buy.id);
  console.log("Buy fill price:", fill);
  const entry = fill ?? ask;
  if (!entry || entry <= 0) {
    throw new Error(`Cannot determine valid entry price (fill=${fill}, ask=${ask})`);
  }
  // 🪓 Split: core (+8% limit) / mid (+12% limit, +8% stop after core) / runner (trailing)
  const useRunner = RUNNER_ENABLED && qty >= RUNNER_MIN_QTY;
  const useMid    = MID_ENABLED    && qty >= MID_MIN_QTY;
  const runnerQty = useRunner ? 1 : 0;
  const midQty    = useMid    ? 1 : 0;
  const coreQty   = qty - runnerQty - midQty;
  if (coreQty < 1) {
    throw new Error(`Tier split produced coreQty<1 (qty=${qty}, mid=${midQty}, runner=${runnerQty})`);
  }
  const coreTarget = +(entry * (1 + PROFIT_PCT)).toFixed(2);
  const midTarget  = useMid ? +(entry * (1 + MID_TARGET_PCT)).toFixed(2) : null;
  const midStop    = useMid ? +(entry * (1 + MID_STOP_PCT)).toFixed(2)   : null;
  console.log(
    `🎯 Entry: ${entry}  |  ` +
    `Core(${coreQty}) → ${coreTarget} (+${(PROFIT_PCT*100).toFixed(0)}%)` +
    (useMid ? `  |  Mid(${midQty}) → ${midTarget} (+${(MID_TARGET_PCT*100).toFixed(0)}%) / stop ${midStop} (+${(MID_STOP_PCT*100).toFixed(0)}% after core)` : "") +
    (useRunner ? `  |  Runner(${runnerQty}) → trail ${(RUNNER_GIVEBACK_PCT*100).toFixed(0)}% giveback` : "")
  );
  // Place CORE limit. Place MID limit (no stop yet — that activates virtually after core fills).
  // Runner has no resting order — fully virtual.
  const coreSell = await placeOrder(option.symbol, "sell_to_close", coreQty, "limit", coreTarget);
  let midSellId = null;
  if (useMid) {
    const midSell = await placeOrder(option.symbol, "sell_to_close", midQty, "limit", midTarget);
    midSellId = midSell.id;
  }
  // ⏰ Time stop — "did the trade work?" gate.
  //    If core +8% has NOT filled within TIME_STOP_MIN min, the move never
  //    developed → close ALL legs (core + mid + runner) at market and walk away.
  //    If core HAS filled, do nothing here: mid + runner ride freely on their
  //    own exits (limit / virtual stop / trailing), backed by the EOD failsafe.
  const timeout = setTimeout(async () => {
    if (!activeTrade) return;
    const trade = activeTrade;
    if (!trade.core || trade.core.filled) return; // core already hit +8% — let mid/runner ride
    console.log("⏰ 30-min time stop, core never filled — closing ALL legs at market");
    activeTrade = null;
    if (trade.eodTimeout) clearTimeout(trade.eodTimeout);
    stopWatcher();
    // Core
    try { await cancelOrder(trade.core.sellId); } catch {}
    try { await placeOrder(trade.symbol, "sell_to_close", trade.core.qty, "market"); }
    catch (e) { console.log("core market-sell err:", e.message); }
    trade.core.filled = true;
    // Mid
    if (trade.mid && !trade.mid.closed) {
      try { await cancelOrder(trade.mid.sellId); } catch {}
      try { await placeOrder(trade.symbol, "sell_to_close", trade.mid.qty, "market"); }
      catch (e) { console.log("mid market-sell err:", e.message); }
      trade.mid.closed = true;
    }
    // Runner
    if (trade.runner && !trade.runner.closed && trade.runner.qty > 0) {
      try { await placeOrder(trade.symbol, "sell_to_close", trade.runner.qty, "market"); }
      catch (e) { console.log("runner market-sell err:", e.message); }
      trade.runner.closed = true;
    }
    console.log("⏰ Time-stop flush complete — flat.");
  }, TIME_STOP_MIN * 60000);
  // 🌅 EOD failsafe — final safety net for any leg still open near close
  const eodMs = msUntilEodEt();
  const eodTimeout = eodMs > 0 ? setTimeout(async () => {
    if (!activeTrade) return;
    console.log("🌅 EOD failsafe firing — closing any open legs");
    const trade = activeTrade;
    activeTrade = null;
    clearTimeout(trade.timeout);
    stopWatcher();
    if (trade.core && !trade.core.filled) {
      try { await cancelOrder(trade.core.sellId); } catch {}
      await placeOrder(trade.symbol, "sell_to_close", trade.core.qty, "market");
    }
    if (trade.mid && !trade.mid.closed) {
      try { await cancelOrder(trade.mid.sellId); } catch {}
      await placeOrder(trade.symbol, "sell_to_close", trade.mid.qty, "market");
    }
    if (trade.runner && !trade.runner.closed && trade.runner.qty > 0) {
      await placeOrder(trade.symbol, "sell_to_close", trade.runner.qty, "market");
    }
  }, eodMs) : null;
  if (eodMs > 0) {
    console.log(`🌅 EOD failsafe armed in ${Math.round(eodMs/60000)} min (${EOD_FAILSAFE_HHMM_ET.join(":")} ET)`);
  } else {
    console.log("🌅 EOD failsafe NOT armed (already past failsafe time)");
  }
  activeTrade = {
    symbol: option.symbol,
    qty,
    entry,
    openedAt: Date.now(),
    timeout,
    eodTimeout,
    core: {
      qty: coreQty,
      target: coreTarget,
      sellId: coreSell.id,
      filled: false,
    },
    mid: useMid ? {
      qty: midQty,
      target: midTarget,
      sellId: midSellId,
      stopLevel: midStop,        // +8% above entry — activated after core fills
      stopActivated: false,
      closed: false,
    } : null,
    runner: useRunner ? {
      qty: runnerQty,
      activated: false,           // true once core fills
      high: entry,                // running max since activation
      stop: null,                 // virtual trailing stop level (giveback math)
      closed: false,
    } : null,
  };
  startSellWatcher();
  console.log(`✅ TRADE OPEN  total=${qty} (core=${coreQty}, mid=${midQty}, runner=${runnerQty})  entry=${entry}`);
  return { ok: true, qty, entry, coreTarget, coreQty, midQty, midTarget, runnerQty, bp };
  } finally {
    tradingLock = false;
  }
}
let sellWatcherInterval = null;
function stopWatcher() {
  if (sellWatcherInterval) {
    clearInterval(sellWatcherInterval);
    sellWatcherInterval = null;
  }
}
// Watcher runs every SELL_POLL_INTERVAL_MS and manages all three legs:
//   1) Core limit — when it fills, activate mid stop and runner trailing.
//   2) Mid limit — track fills/cancels. If stop is activated and price ≤ stop, cancel + market sell.
//   3) Runner — virtual trailing stop using profit-giveback math, floored at breakeven.
//   4) Cleanup when every leg is resolved.
function startSellWatcher() {
  stopWatcher();
  sellWatcherInterval = setInterval(async () => {
    if (!activeTrade) { stopWatcher(); return; }
    const t = activeTrade;
    try {
      // ── 1. Core monitoring ──────────────────────────────
      if (t.core && !t.core.filled) {
        const order = await getOrderStatus(t.core.sellId);
        if (order.status === "filled") {
          console.log(`✅ CORE FILLED @ ${order.avg_fill_price} (qty ${t.core.qty})`);
          t.core.filled = true;
          // Activate mid stop (locks in +8% on the mid contract)
          if (t.mid && !t.mid.stopActivated && !t.mid.closed) {
            t.mid.stopActivated = true;
            console.log(`🛡️ MID STOP ARMED at ${t.mid.stopLevel} (+${(MID_STOP_PCT*100).toFixed(0)}%)`);
          }
          // Activate runner trailing
          if (t.runner && !t.runner.activated) {
            t.runner.activated = true;
            t.runner.high = Math.max(t.entry, parseFloat(order.avg_fill_price) || t.entry);
            t.runner.stop = t.entry; // BE floor
            console.log(`🏃 RUNNER ACTIVATED  high=${t.runner.high}  stop=${t.runner.stop} (BE)`);
          }
        } else if (order.status === "canceled" || order.status === "expired") {
          console.warn(`⚠️ Core order ${order.status} — market-closing core`);
          const coreQty = t.core.qty;
          t.core.filled = true; // resolved
          await placeOrder(t.symbol, "sell_to_close", coreQty, "market");
          // Activate downstream legs anyway with BE protection
          if (t.mid && !t.mid.stopActivated && !t.mid.closed) {
            t.mid.stopActivated = true;
            console.log(`🛡️ MID STOP ARMED (after core cancel) at ${t.mid.stopLevel}`);
          }
          if (t.runner && !t.runner.activated) {
            t.runner.activated = true;
            t.runner.high = t.entry;
            t.runner.stop = t.entry;
            console.log(`🏃 RUNNER ACTIVATED (after core cancel)  stop=${t.entry}`);
          }
        }
      }
      // ── 2a. Mid limit-fill check ────────────────────────
      if (t.mid && !t.mid.closed) {
        const order = await getOrderStatus(t.mid.sellId);
        if (order.status === "filled") {
          console.log(`✅ MID TARGET HIT — filled @ ${order.avg_fill_price} (qty ${t.mid.qty})`);
          t.mid.closed = true;
        } else if (order.status === "canceled" || order.status === "expired") {
          // Already handled by stop logic below if we cancelled it ourselves.
          // If it canceled unexpectedly, market-close so we don't leak.
          if (!t.mid.closed) {
            console.warn(`⚠️ Mid order ${order.status} unexpectedly — market-closing mid`);
            t.mid.closed = true;
            await placeOrder(t.symbol, "sell_to_close", t.mid.qty, "market");
          }
        }
      }
      // ── 2b. Mid stop check (only after core fills) ──────
      const needPrice = (t.mid && t.mid.stopActivated && !t.mid.closed)
                     || (t.runner && t.runner.activated && !t.runner.closed && t.runner.qty > 0);
      let price = null;
      if (needPrice) {
        try {
          price = await getOptionPrice(t.symbol);
        } catch (e) {
          console.warn("⚠️ Quote fetch failed:", e.message);
        }
      }
      if (price != null && t.mid && t.mid.stopActivated && !t.mid.closed) {
        if (price <= t.mid.stopLevel) {
          console.log(`🛑 MID STOP HIT — price ${price} ≤ ${t.mid.stopLevel}, cancelling limit + market-selling`);
          t.mid.closed = true;
          try {
            await cancelOrder(t.mid.sellId);
            await placeOrder(t.symbol, "sell_to_close", t.mid.qty, "market");
          } catch (e) {
            console.error("❌ Mid stop sell failed:", e.message);
            t.mid.closed = false; // retry next tick
          }
        }
      }
      // ── 3. Runner trailing (40% profit giveback) ────────
      if (price != null && t.runner && t.runner.activated && !t.runner.closed && t.runner.qty > 0) {
        if (price > t.runner.high) {
          t.runner.high = price;
          // stop = entry + (high − entry) × (1 − GIVEBACK), floored at entry
          const gain = t.runner.high - t.entry;
          const candidate = +(t.entry + gain * (1 - RUNNER_GIVEBACK_PCT)).toFixed(2);
          const newStop = Math.max(t.entry, candidate);
          if (newStop > t.runner.stop) {
            t.runner.stop = newStop;
            console.log(`📈 Runner trail raised: high=${t.runner.high}  stop=${t.runner.stop} (locked in $${(t.runner.stop - t.entry).toFixed(2)} / contract)`);
          }
        }
        if (price <= t.runner.stop) {
          console.log(`🛑 Runner trail HIT — price ${price} ≤ stop ${t.runner.stop}, market-selling`);
          t.runner.closed = true;
          try {
            await placeOrder(t.symbol, "sell_to_close", t.runner.qty, "market");
          } catch (e) {
            console.error("❌ Runner market sell failed:", e.message);
            t.runner.closed = false; // retry next tick
          }
        }
      }
      // ── 4. Cleanup ──────────────────────────────────────
      const coreDone   = !t.core   || t.core.filled;
      const midDone    = !t.mid    || t.mid.closed;
      const runnerDone = !t.runner || t.runner.closed || t.runner.qty === 0;
      if (coreDone && midDone && runnerDone) {
        console.log("🏁 Trade fully closed");
        clearTimeout(t.timeout);
        if (t.eodTimeout) clearTimeout(t.eodTimeout);
        stopWatcher();
        activeTrade = null;
      }
    } catch (err) {
      console.error("⚠️ Watcher error:", err.message);
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
  // earlyBird reset moved into openTrade() so /fire also clears it.
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
// Use app.all so these work via browser (GET) AND curl/webhook (POST)
app.all("/pause", (req, res) => {
  botPaused = true;
  console.log("⏸️ Bot paused");
  res.json({ paused: true });
});
app.all("/resume", (req, res) => {
  botPaused = false;
  console.log("▶️ Bot resumed");
  res.json({ paused: false });
});
app.all("/skip", (req, res) => {
  skipNext = true;
  console.log("⏭️ Next signal will be skipped");
  res.json({ skipNext: true });
});
app.get("/status", (req, res) => {
  res.json({
    activeTrade,
    botPaused,
    skipNext,
    earlyBird,
    maxContracts: MAX_CONTRACTS,
    config: {
      profitPct: PROFIT_PCT,
      midEnabled: MID_ENABLED, midMinQty: MID_MIN_QTY, midTargetPct: MID_TARGET_PCT, midStopPct: MID_STOP_PCT,
      runnerEnabled: RUNNER_ENABLED, runnerMinQty: RUNNER_MIN_QTY, runnerGivebackPct: RUNNER_GIVEBACK_PCT,
    },
  });
});
// Quick sanity endpoint — shows what the bot would size & split RIGHT NOW.
app.get("/sizing", async (req, res) => {
  try {
    const spy    = await getSPYPrice();
    const option = await getATMCall(spy);
    const bp     = await getOptionBuyingPower();
    const ask    = parseFloat(option.ask);
    const qty    = calcContracts(ask, bp);
    const useRunner = RUNNER_ENABLED && qty >= RUNNER_MIN_QTY;
    const useMid    = MID_ENABLED    && qty >= MID_MIN_QTY;
    const runnerQty = useRunner ? 1 : 0;
    const midQty    = useMid    ? 1 : 0;
    const coreQty   = qty - runnerQty - midQty;
    res.json({
      spy, strike: option.strike, ask, bp,
      qty, coreQty, midQty, runnerQty,
      maxContracts: MAX_CONTRACTS,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ─── EARLYBIRD ──────────────────────────────────
// Sets a one-shot flag that lets the next signal bypass the trading-window gate.
// Auto-expires after EARLYBIRD_TTL_MIN minutes so it can't leak into the afternoon.
app.all("/earlybird", (req, res) => {
  earlyBird = true;
  if (earlyBirdTimer) clearTimeout(earlyBirdTimer);
  earlyBirdTimer = setTimeout(() => {
    if (earlyBird) {
      earlyBird = false;
      console.log(`🐦 earlyBird auto-expired after ${EARLYBIRD_TTL_MIN} min`);
    }
    earlyBirdTimer = null;
  }, EARLYBIRD_TTL_MIN * 60000);
  console.log(`🐦 earlyBird ON — expires in ${EARLYBIRD_TTL_MIN} min`);
  res.json({ earlyBird: true, expiresInMin: EARLYBIRD_TTL_MIN });
});
// Manual reset, in case you want to cancel an armed earlybird.
app.all("/earlybird/off", (req, res) => {
  earlyBird = false;
  if (earlyBirdTimer) { clearTimeout(earlyBirdTimer); earlyBirdTimer = null; }
  console.log("🐦 earlyBird manually cleared");
  res.json({ earlyBird: false });
});
// ─── BREAKEVEN ──────────────────────────────────
// Pulls every still-open leg back to entry so the worst case is BE.
// • Core (unfilled): cancel + replace limit at entry
// • Mid (open):      cancel + replace limit at entry, AND arm stop at entry
// • Runner (active): pin trailing-stop floor at entry
app.all("/breakeven", async (req, res) => {
  if (!activeTrade) return res.status(400).json({ error: "No active trade" });
  const t = activeTrade;
  try {
    console.log("⚖️ Setting breakeven across all legs...");
    const result = { ok: true };
    if (t.core && !t.core.filled) {
      await cancelOrder(t.core.sellId);
      const sell = await placeOrder(t.symbol, "sell_to_close", t.core.qty, "limit", t.entry);
      t.core.sellId = sell.id;
      t.core.target = t.entry;
      result.core = { qty: t.core.qty, target: t.entry };
      console.log(`⚖️ Core sell moved to BE @ ${t.entry}`);
    }
    if (t.mid && !t.mid.closed) {
      await cancelOrder(t.mid.sellId);
      const sell = await placeOrder(t.symbol, "sell_to_close", t.mid.qty, "limit", t.entry);
      t.mid.sellId = sell.id;
      t.mid.target = t.entry;
      t.mid.stopLevel = t.entry;
      t.mid.stopActivated = true;
      result.mid = { qty: t.mid.qty, target: t.entry, stop: t.entry };
      console.log(`⚖️ Mid moved to BE @ ${t.entry} (stop also armed at BE)`);
    }
    if (t.runner && t.runner.activated && !t.runner.closed) {
      t.runner.stop = Math.max(t.runner.stop || 0, t.entry);
      result.runner = { qty: t.runner.qty, stop: t.runner.stop };
      console.log(`⚖️ Runner trail floor pinned at BE ${t.runner.stop}`);
    }
    startSellWatcher();
    res.json(result);
  } catch (err) {
    console.error("❌ Breakeven error:", err.message);
    res.status(500).json({ error: err.message });
  }
});
// ─── EXTEND ─────────────────────────────────────
app.all("/extend", (req, res) => {
  if (!activeTrade) return res.status(400).json({ error: "No active trade" });
  clearTimeout(activeTrade.timeout);
  activeTrade.timeout = setTimeout(async () => {
    if (!activeTrade) return;
    const trade = activeTrade;
    if (!trade.core || trade.core.filled) return; // core hit +8% — let mid/runner ride
    console.log("⏰ Extended time stop, core never filled — closing ALL legs at market");
    activeTrade = null;
    if (trade.eodTimeout) clearTimeout(trade.eodTimeout);
    stopWatcher();
    try { await cancelOrder(trade.core.sellId); } catch {}
    try { await placeOrder(trade.symbol, "sell_to_close", trade.core.qty, "market"); }
    catch (e) { console.log("core market-sell err:", e.message); }
    trade.core.filled = true;
    if (trade.mid && !trade.mid.closed) {
      try { await cancelOrder(trade.mid.sellId); } catch {}
      try { await placeOrder(trade.symbol, "sell_to_close", trade.mid.qty, "market"); }
      catch (e) { console.log("mid market-sell err:", e.message); }
      trade.mid.closed = true;
    }
    if (trade.runner && !trade.runner.closed && trade.runner.qty > 0) {
      try { await placeOrder(trade.symbol, "sell_to_close", trade.runner.qty, "market"); }
      catch (e) { console.log("runner market-sell err:", e.message); }
      trade.runner.closed = true;
    }
    console.log("⏰ Extended time-stop flush complete — flat.");
  }, TIME_STOP_MIN * 60000);
  console.log(`⏱️ Timer reset to ${TIME_STOP_MIN} min`);
  res.json({ ok: true, resetTo: TIME_STOP_MIN });
});
// ─── EMERGENCY ──────────────────────────────────
// Hard exit: cancels any resting orders and market-sells whatever's still open.
app.all("/emergency", async (req, res) => {
  if (!activeTrade) return res.status(400).json({ error: "No active trade" });
  try {
    console.log("🚨 EMERGENCY — closing everything at market");
    const trade = activeTrade;
    activeTrade = null;
    clearTimeout(trade.timeout);
    if (trade.eodTimeout) clearTimeout(trade.eodTimeout);
    stopWatcher();
    let totalSold = 0;
    if (trade.core && !trade.core.filled) {
      await cancelOrder(trade.core.sellId);
      await placeOrder(trade.symbol, "sell_to_close", trade.core.qty, "market");
      totalSold += trade.core.qty;
    }
    if (trade.mid && !trade.mid.closed) {
      await cancelOrder(trade.mid.sellId);
      await placeOrder(trade.symbol, "sell_to_close", trade.mid.qty, "market");
      totalSold += trade.mid.qty;
    }
    if (trade.runner && !trade.runner.closed && trade.runner.qty > 0) {
      await placeOrder(trade.symbol, "sell_to_close", trade.runner.qty, "market");
      totalSold += trade.runner.qty;
    }
    res.json({ ok: true, sold: "market", qty: totalSold });
  } catch (err) {
    console.error("❌ Emergency error:", err.message);
    res.status(500).json({ error: err.message });
  }
});
// ─── FIRE (manual trade entry) ──────────────────
// /fire           → auto-size based on buying power (capped at MAX_CONTRACTS)
// /fire1 .. /fire5 → fire with exactly N contracts (still BP-checked, will refuse if insufficient)
// /fire/:n        → same idea via path param (e.g. /fire/3)
app.all(/^\/fire([1-9][0-9]?)?$/, async (req, res) => {
  // The captured digit is in req.params[0] for the regex form
  const captured = req.params[0];
  const requestedQty = captured ? parseInt(captured, 10) : null;
  console.log(`🔥 FIRE — manual trade triggered${requestedQty ? ` (qty=${requestedQty})` : " (auto-size)"}`);
  if (activeTrade) return res.status(400).json({ error: "Already in a trade" });
  try {
    const result = await openTrade(requestedQty);
    if (result.skipped) return res.status(400).json({ error: result.reason, ...result });
    res.json(result);
  } catch (err) {
    console.error("❌ FIRE error:", err.message);
    res.status(500).json({ error: err.message });
  }
});
// Path-param form for cleaner URLs: /fire/3
app.all("/fire/:qty(\\d+)", async (req, res) => {
  const requestedQty = parseInt(req.params.qty, 10);
  console.log(`🔥 FIRE — manual trade triggered (qty=${requestedQty})`);
  if (activeTrade) return res.status(400).json({ error: "Already in a trade" });
  try {
    const result = await openTrade(requestedQty);
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
