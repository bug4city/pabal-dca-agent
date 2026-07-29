// Pabal(BOBOO) remote DCA vault agent — BUG Smart DCA (RSI-weighted)
// 에이전트는 키를 쥐지 않는다: dca.execute는 "실행 제안(proposal)"만 반환하고,
// 온체인 집행(StrategyVault.executeDca)·한도 재검증은 플랫폼 브로커가 한다.
// 회차 금액 결정 = BUG 시그널 에이전트(#9, 같은 마켓)의 BTC RSI+국면을 호출해 가중.

const SIGNAL_ENDPOINT = "https://pabal-signal-agent.vercel.app";
const GIWA_RPC = "https://sepolia-rpc.giwa.io";
const VAULT = "0x6ad0bf49C4B2A275EdcD5B8567d92468b73F4450"; // test.pabal.ai StrategyVault
const BASE_USDT = 5;      // 기본 회차 금액
const MAX_USDT = 10;      // manifest maxUsdtPerTask와 일치 (온체인 maxPerExecution도 동일 설정)
const STRATEGY =
  "Smart DCA timing gate: BTC 4H RSI(14) + daily SMA200 regime decide GO/SKIP for each round. " +
  "Overheated (RSI>=65) rounds are skipped; otherwise the declared per-round size executes. " +
  "Execution is proposal-only; the platform broker enforces the declared size, interval, on-chain cap and user balance.";

class BadRequest extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

async function fetchJson(url, body, timeoutMs = 10000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", "User-Agent": "pabal-dca-agent/1.0" },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`${url} http ${r.status}`);
    return j;
  } finally {
    clearTimeout(t);
  }
}

// BTC 4H 스냅샷(RSI·국면)을 시그널 에이전트에서 읽는다. 실패해도 실행은 막지 않는다(중립 1.0x).
async function btcContext() {
  try {
    const j = await fetchJson(SIGNAL_ENDPOINT, { action: "signal.latest", symbol: "BTC", timeframe: "4H" });
    const sym = j.symbols?.BTCUSDT;
    const frame = sym?.frames?.["4H"];
    const rsi = Number(frame?.rsi);
    const regime = String(sym?.regime || "").toLowerCase() || null;
    if (!Number.isFinite(rsi)) throw new Error("no rsi in signal response");
    return { ok: true, rsi, regime, price: Number(sym?.price ?? frame?.close) || null };
  } catch (e) {
    return { ok: false, rsi: null, regime: null, price: null, error: e.message };
  }
}

function decideAmount(baseUsdt, ctx) {
  let mult = 1.0;
  const reasons = [];
  if (ctx.ok) {
    if (ctx.rsi <= 35) { mult = 1.5; reasons.push(`RSI ${ctx.rsi.toFixed(1)} oversold -> x1.5`); }
    else if (ctx.rsi <= 45) { mult = 1.25; reasons.push(`RSI ${ctx.rsi.toFixed(1)} dip -> x1.25`); }
    else if (ctx.rsi >= 65) { mult = 0.5; reasons.push(`RSI ${ctx.rsi.toFixed(1)} overheated -> x0.5`); }
    else reasons.push(`RSI ${ctx.rsi.toFixed(1)} neutral -> x1.0`);
    if (ctx.regime === "bear") { mult *= 0.75; reasons.push("bear regime -> x0.75"); }
  } else {
    reasons.push(`signal unavailable (${ctx.error}) -> neutral x1.0`);
  }
  const raw = baseUsdt * mult;
  const amount = Math.min(MAX_USDT, Math.max(1, Math.round(raw * 100) / 100));
  return { amount, mult, reasons };
}

// 유저/에이전트 식별자는 브로커가 어떤 필드로 보내든 줍는다 (라이브 브로커 호출 형태 유연 대응).
function pick(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== "") return v;
  return null;
}

async function vaultPosition(agentId, user) {
  // positions(uint256,address) selector 기반 raw eth_call (의존성 0)
  const { ethers } = require("ethers");
  const provider = new ethers.JsonRpcProvider(GIWA_RPC);
  const vault = new ethers.Contract(VAULT, [
    "function positions(uint256,address) view returns (uint256 usdtBalance, uint256 dogeBalance, bytes32 riskAckHash)",
    "function maxPerExecution(uint256) view returns (uint256)",
  ], provider);
  const [pos, cap] = await Promise.all([vault.positions(agentId, user), vault.maxPerExecution(agentId)]);
  return {
    usdtRemaining: ethers.formatUnits(pos.usdtBalance, 6),
    dogeAccumulated: ethers.formatUnits(pos.dogeBalance, 8),
    onchainMaxPerExecution: ethers.formatUnits(cap, 6),
  };
}

const ACTIONS = {
  async "dca.plan"(request, ids) {
    // GO/SKIP 게이트의 정본. 러너(봇)는 매 회차 이걸 먼저 묻고 go=true일 때만
    // dca.execute 태스크를 제출한다 (라이브 브로커는 실행 태스크에 proposal을 강제하므로
    // 스킵은 "태스크를 안 내는 것"으로 구현 — KPI 거절 오염 0).
    // simulate="overheated"는 테스트용: 스킵(자금 미이동) 방향으로만 강제 가능.
    const base = Number(request.usdtAmount) > 0 ? Number(request.usdtAmount) : BASE_USDT;
    const ctx = request.simulate === "overheated"
      ? { ok: true, rsi: 70, regime: "bull", price: null, simulated: true }
      : await btcContext();
    const d = decideAmount(base, ctx);
    const go = !(ctx.ok && ctx.rsi >= 65);
    return {
      go,
      plan: { usdtAmount: base, advisoryMultiplier: d.mult },
      market: { btcRsi4h: ctx.rsi, regime: ctx.regime, btcPrice: ctx.price },
      reasons: go ? d.reasons : [...d.reasons, "overheated -> skip this round"],
      ...(ctx.simulated ? { simulated: true } : {}),
      note: "go=false means skip this round (do not submit dca.execute). Execution size is always the declared strategy.perExecutionUsdt.",
    };
  },

  async "dca.execute"(request, ids) {
    // 라이브 브로커 계약: vault 실행 태스크는 proposal 필수 + usdtAmount는 manifest
    // strategy.perExecutionUsdt와 정확히 일치(proposal 없거나 불일치면 500/403).
    // 따라서 실행 액션은 항상 선언값 proposal을 반환하고, GO/SKIP 판단은 dca.plan에서
    // 러너가 사전 수행한다.
    const declared = Number(ids.strategyUsdt) > 0 ? Number(ids.strategyUsdt) : BASE_USDT;
    const ctx = await btcContext();
    if (ids.agentId === null || !ids.user) {
      throw new BadRequest("missing_context", "agentId/user not found in request", { got: ids });
    }
    return {
      proposal: {
        kind: "vault.executeDca",
        agentId: Number(ids.agentId),
        user: ids.user,
        usdtAmount: declared,
      },
      decision: {
        declaredUsdt: declared,
        market: { btcRsi4h: ctx.rsi, regime: ctx.regime, btcPrice: ctx.price },
        note: "Timing gate runs in dca.plan (go/skip). This action always executes the declared size.",
      },
    };
  },

  async "dca.status"(request, ids) {
    if (ids.agentId === null || !ids.user) {
      throw new BadRequest("missing_context", "agentId/user not found in request", { got: ids });
    }
    const pos = await vaultPosition(Number(ids.agentId), ids.user);
    // 다음 회차 시각: 브로커가 context(lastExecutionAt + strategy.intervalSec)를 줄 때만 계산 가능
    const nextDueAt = ids.lastExecutionAt && ids.intervalSec
      ? new Date((Number(ids.lastExecutionAt) + Number(ids.intervalSec)) * 1000).toISOString()
      : null;
    return {
      summary: [
        `Vault balance: ${pos.usdtRemaining} USDT remaining, ${pos.dogeAccumulated} DOGE accumulated`,
        `Per-round cap (on-chain): ${pos.onchainMaxPerExecution} USDT`,
        nextDueAt ? `Next round executable after: ${nextDueAt}` : "Next round: after strategy interval since last execution",
        "Withdraw returns the FULL position (USDT+DOGE) to your own address only.",
      ],
      agentId: Number(ids.agentId),
      user: ids.user,
      position: pos,
      ...(nextDueAt ? { nextDueAt } : {}),
    };
  },
};

module.exports = async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      agent: "bug-smart-dca",
      description: "BUG Smart DCA vault agent for the Pabal/BOBOO marketplace. RSI-weighted DCA sizing; proposal-only execution.",
      actions: Object.keys(ACTIONS),
      strategy: STRATEGY,
      custody: "Non-custodial: deposits sit in StrategyVault; withdrawals only to the depositor address; on-chain per-execution cap.",
      disclaimer: "GIWA Sepolia testnet demo. Not real assets. Not investment advice.",
    });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  let body = req.body || {};
  if (typeof body === "string") {
    const raw = body.trim();
    if (!raw) body = {};
    else {
      try { body = JSON.parse(raw); } catch {
        return res.status(400).json({ error: "invalid_json", message: "request body must be valid JSON" });
      }
    }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return res.status(400).json({ error: "invalid_body", message: "request body must be a JSON object" });
  }
  // 브로커 원격 호출 형태 관측용 (Vercel logs)
  try { console.log("inbound", req.url, JSON.stringify(body).slice(0, 1500)); } catch {}

  const request = (body.request && typeof body.request === "object") ? body.request
    : (body.input && typeof body.input === "object") ? body.input
    : body;
  const ctxObj = (body.ctx && typeof body.ctx === "object") ? body.ctx
    : (body.context && typeof body.context === "object") ? body.context : {};
  const ids = {
    agentId: pick(body.agentId, request.agentId, ctxObj.agentId),
    user: pick(body.user, request.user, ctxObj.user, body.userAddress, request.userAddress),
    strategyUsdt: ctxObj.strategy?.perExecutionUsdt,
    intervalSec: ctxObj.strategy?.intervalSec,
    lastExecutionAt: ctxObj.lastExecutionAt,
  };
  const action = request.action || body.action;
  const handler = ACTIONS[action];
  if (!handler) return res.status(400).json({ error: "unknown_action", got: action || null, actions: Object.keys(ACTIONS) });

  try {
    const result = await handler(request, ids);
    return res.status(200).json(result);
  } catch (e) {
    if (e instanceof BadRequest) return res.status(400).json({ error: e.code, message: e.message, ...e.extra });
    console.error("action_failed", action, e.message);
    return res.status(500).json({ error: "agent_failed", message: e.message });
  }
};
