#!/usr/bin/env node
// pabal DCA 봇 러너 — Agent #12 (BUG Smart DCA)의 자동실행 데몬 사이클.
// launchd(com.bug.pabal-dca-runner)가 주기 실행. 1사이클:
//   1) 에이전트 dca.plan(AI GO/SKIP 게이트, BTC RSI+국면) 조회
//   2) go=false → 이번 회차 스킵 (태스크 미제출 — 브로커는 실행 태스크에 proposal을 강제하므로
//      스킵은 태스크를 안 내는 것으로 구현)
//   3) go=true → EIP-712 TaskRequest 서명 → POST /task/12 → 브로커가 온체인 집행
//   not_due(주기 미도래)는 정상 응답으로 로그만 남긴다.
// 로그는 파일에만 쓴다(EPIPE 방어). 실패 시 discord-notify general.

require("dotenv").config({ path: __dirname + "/.env" });
require("dotenv").config({ path: __dirname + "/../.env" });
const fs = require("fs");
const { execFileSync } = require("child_process");
const { ethers } = require("ethers");
const SIGNER_KEY = process.env.PRIVATE_KEY || process.env.DEPLOYER_KEY;

const AGENT_ID = 12;
const BROKER = "https://test.pabal.ai";
const ENDPOINT = "https://pabal-dca-agent.vercel.app";
const LOG_FILE = process.env.HOME + "/.local/log/pabal-dca-runner.log";
try { fs.mkdirSync(process.env.HOME + "/.local/log", { recursive: true }); } catch {}
const STATE_FILE = __dirname + "/state.json";

// EPIPE 방어 3종 (CLAUDE.md 데몬 규칙)
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
process.on("uncaughtException", (e) => {
  if (e && e.code === "EPIPE") return;
  log(`FATAL uncaught: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});

function log(msg) {
  try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`); } catch {}
}

function notify(msg) {
  if (!fs.existsSync(process.env.HOME + "/.local/bin/discord-notify")) return;
  try {
    execFileSync(process.env.HOME + "/.local/bin/discord-notify", ["general", msg], { timeout: 15000, stdio: "ignore" });
  } catch (e) { log(`notify failed: ${e.message}`); }
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
}

async function fetchJson(url, body, timeoutMs = 45000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", "User-Agent": "pabal-dca-runner/1.0" },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, json: j };
  } finally { clearTimeout(t); }
}

const TASK_REQUEST_TYPES = { TaskRequest: [
  { name: "broker", type: "address" },
  { name: "user", type: "address" },
  { name: "agentId", type: "uint256" },
  { name: "requestHash", type: "bytes32" },
  { name: "nonce", type: "bytes32" },
  { name: "deadline", type: "uint64" },
]};

(async () => {
  const state = loadState();
  try {
    // 1) AI 게이트
    const plan = await fetchJson(ENDPOINT, { action: "dca.plan" });
    if (!plan.ok) throw new Error(`plan http ${plan.status}: ${JSON.stringify(plan.json).slice(0, 200)}`);
    const { go, market, reasons } = plan.json;
    if (!go) {
      log(`SKIP rsi=${market?.btcRsi4h} regime=${market?.regime} reasons=${JSON.stringify(reasons)}`);
      state.lastRun = { at: new Date().toISOString(), outcome: "skip", rsi: market?.btcRsi4h };
      state.failStreak = 0; saveState(state);
      return;
    }

    // 2) 실행 태스크 제출
    const mp = await fetchJson(BROKER + "/marketplace");
    if (!mp.ok) throw new Error(`marketplace http ${mp.status}`);
    const auth712 = mp.json.auth;
    const wallet = new ethers.Wallet(SIGNER_KEY);
    const request = { action: "dca.execute" };
    const requestHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(request)));
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const deadline = Math.floor(Date.now() / 1000) + 120;
    const auth = { broker: auth712.broker, user: wallet.address, agentId: AGENT_ID, requestHash, nonce, deadline };
    const domain = { name: auth712.domainName, version: auth712.domainVersion, chainId: auth712.chainId, verifyingContract: auth712.verifyingContract };
    const signature = await wallet.signTypedData(domain, TASK_REQUEST_TYPES, auth);
    const res = await fetchJson(`${BROKER}/task/${AGENT_ID}`, { user: wallet.address, request, auth, signature }, 60000);

    if (res.ok && res.json?.result?.executed) {
      const r = res.json.result;
      log(`EXECUTED usdt=${r.usdtAmount} total=${r.completedExecutions} rsi=${market?.btcRsi4h} tx=${r.txHash} receipt=${res.json.receipt?.receiptId}`);
      state.lastRun = { at: new Date().toISOString(), outcome: "executed", completedExecutions: r.completedExecutions };
      state.failStreak = 0;
    } else if (res.ok && res.json?.result?.status === "not_due") {
      log(`NOT_DUE nextInSec=${res.json.result.nextInSec}`);
      state.lastRun = { at: new Date().toISOString(), outcome: "not_due" };
      state.failStreak = 0;
    } else {
      throw new Error(`task http ${res.status}: ${JSON.stringify(res.json).slice(0, 300)}`);
    }
    saveState(state);
  } catch (e) {
    log(`ERROR ${e.message}`);
    state.failStreak = (state.failStreak || 0) + 1;
    state.lastRun = { at: new Date().toISOString(), outcome: "error", error: e.message.slice(0, 200) };
    saveState(state);
    if (state.failStreak === 2) notify(`⚠️ pabal DCA 러너 2연속 실패: ${e.message.slice(0, 180)}`);
  }
})();
