#!/usr/bin/env node
// Pabal(BOBOO) 제작자 등록 스크립트 — BUG Smart DCA vault 에이전트 (onchainType 2).
// pabal-signal-agent/register.js와 동일 플로우 + 볼트 전용 커맨드(cap/deposit/position/withdraw).
// 사용: node register.js <status|validate|register|submit|update|pricing|credits|cap|deposit|position|withdraw|task>
// 키: ~/Desktop/giwa-workforce/contracts/.env 의 DEPLOYER_KEY (출력 금지)

// Key loading: local .env (PRIVATE_KEY=0x...) first, then legacy team path as fallback.
// Judges: `cp .env.example .env` and put your own GIWA Sepolia key — never commit it.
require("dotenv").config({ path: __dirname + "/.env" });
if (!process.env.PRIVATE_KEY && !process.env.DEPLOYER_KEY) {
  try {
    require("dotenv").config({ path: require("path").join(process.env.HOME, "Desktop", "giwa-workforce", "contracts", ".env") });
  } catch {}
}
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const SIGNER_KEY = process.env.PRIVATE_KEY || process.env.DEPLOYER_KEY;
if (!SIGNER_KEY) {
  console.error("No key found. Set PRIVATE_KEY=0x... in ./.env (see .env.example).");
  process.exit(1);
}

const BROKER = "https://test.pabal.ai";
const RPC = process.env.GIWA_RPC || "https://sepolia-rpc.giwa.io";
const ENDPOINT = "https://pabal-dca-agent.vercel.app";
const MANIFEST_FILE = path.join(__dirname, "manifest.json");
const STATE_FILE = path.join(__dirname, ".register-state.json");

const MAX_USDT_PER_TASK = 10;   // api/index.js MAX_USDT와 일치
const BASE_USDT = 5;            // api/index.js BASE_USDT와 일치

const REGISTRY_ABI = [
  "function nextAgentId() view returns (uint256)",
  "function agents(uint256) view returns (address owner, string metadataURI, bytes32 manifestHash, uint8 agentType, bool active, uint64 version, uint64 registeredAt)",
  "function registerAgent(string,bytes32,uint8) returns (uint256)",
  "function updateAgent(uint256,string,bytes32)",
  "event AgentRegistered(uint256 indexed agentId,address indexed owner,uint8 agentType,bytes32 manifestHash,string metadataURI)",
];
const HUB_ABI = [
  "function setPricing(uint256 agentId,uint128 subPricePerPeriod,uint128 taskPrice)",
  "function pricing(uint256) view returns (uint128 subPricePerPeriod, uint128 taskPrice)",
  "function credits(address) view returns (uint256)",
  "function depositCredits(uint256 amount)",
];
const USDT_ABI = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];
const VAULT_ABI = [
  "function setMaxPerExecution(uint256 agentId, uint256 maxUsdt)",
  "function maxPerExecution(uint256) view returns (uint256)",
  "function deposit(uint256 agentId, uint256 amount, bytes32 riskAckHash)",
  "function withdraw(uint256 agentId)",
  "function positions(uint256,address) view returns (uint256 usdtBalance, uint256 dogeBalance, bytes32 riskAckHash)",
];
const AGENT_REGISTRATION_TYPES = { AgentRegistration: [
  { name: "agentId", type: "uint256" },
  { name: "manifestHash", type: "bytes32" },
  { name: "deadline", type: "uint64" },
]};
const TASK_REQUEST_TYPES = { TaskRequest: [
  { name: "broker", type: "address" },
  { name: "user", type: "address" },
  { name: "agentId", type: "uint256" },
  { name: "requestHash", type: "bytes32" },
  { name: "nonce", type: "bytes32" },
  { name: "deadline", type: "uint64" },
]};

const RISK_NOTICE =
  "GIWA Sepolia testnet demo - not real assets, unaudited, fixed demo swap rate. " +
  "Deposits are withdrawable only to your own address (non-custodial vault). " +
  "The agent only proposes buy sizes; the on-chain per-execution cap and your remaining balance are the final limits. " +
  "Past performance does not guarantee future returns.";

const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

function buildManifest(agentId) {
  return {
    agentId,
    name: "BUG Smart DCA (RSI-weighted)",
    type: "T3-vault",
    category: "dca-vault",
    onchainType: 2,
    endpoint: ENDPOINT,
    actions: ["dca.plan", "dca.execute", "dca.status"],
    skills: [{
      id: "default",
      name: "BTC RSI-weighted Smart DCA",
      description: "Sizes each DCA round from BTC 4H RSI(14) + daily SMA200 regime (oversold x1.5, dip x1.25, overheated x0.5, bear x0.75). Proposal-only execution against the non-custodial StrategyVault.",
      actions: [
        { name: "dca.plan", label: "Preview this round's buy size (no execution)" },
        { name: "dca.execute", label: "Execute one DCA round via vault" },
        { name: "dca.status", label: "Check my vault position" },
      ],
      tags: ["dca-vault"],
      riskLevel: "medium",
    }],
    tokens: ["USDT", "DOGE"],
    maxUsdtPerTask: MAX_USDT_PER_TASK,
    maxTasksPerDay: 24,
    strategy: { perExecutionUsdt: BASE_USDT, intervalSec: 86400, totalExecutions: 30 },
    display: {
      buys: ["DOGE"],
      fundedWith: "USDT",
      interval: "Daily (RSI-weighted size)",
      withdrawTo: "Owner only",
      executionMode: "vault-primitive",
      demoLabel: "테스트넷 데모 · 미감사 · 고정환율 시뮬",
    },
    riskNotice: RISK_NOTICE,
  };
}

async function api(p, body) {
  const r = await fetch(BROKER + p, body ? {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  } : undefined);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p} http ${r.status}: ${JSON.stringify(j)}`);
  return j;
}

(async () => {
  const cmd = process.argv[2] || "status";
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(SIGNER_KEY, provider);
  const mp = await api("/marketplace");
  const C = mp.contracts;
  const chainId = mp.auth.chainId;
  const registry = new ethers.Contract(C.AgentRegistry, REGISTRY_ABI, wallet);
  const hub = new ethers.Contract(C.PaymentHub, HUB_ABI, wallet);
  const vault = new ethers.Contract(C.StrategyVault, VAULT_ABI, wallet);

  if (cmd === "status") {
    console.log("wallet:", wallet.address, "| ETH:", ethers.formatEther(await provider.getBalance(wallet.address)));
    console.log("nextAgentId:", (await registry.nextAgentId()).toString());
    if (state.agentId) {
      const a = await registry.agents(state.agentId);
      console.log(`agent #${state.agentId}: owner=${a.owner} type=${a.agentType} active=${a.active} hash=${a.manifestHash}`);
      console.log("pricing:", (await hub.pricing(state.agentId)).toString());
      console.log("maxPerExecution:", ethers.formatUnits(await vault.maxPerExecution(state.agentId), 6), "USDT");
      const p = await vault.positions(state.agentId, wallet.address);
      console.log("my position:", ethers.formatUnits(p.usdtBalance, 6), "USDT /", ethers.formatUnits(p.dogeBalance, 8), "DOGE");
    }
    return;
  }

  if (cmd === "validate") {
    const nextId = Number(await registry.nextAgentId());
    const manifest = buildManifest(nextId);
    const manifestRaw = JSON.stringify(manifest);
    const v = await api("/agents/validate", { manifestRaw });
    console.log("validate response:", JSON.stringify(v, null, 2));
    const hint = Number(v.nextAgentIdHint);
    const finalId = Number.isSafeInteger(hint) && hint >= 1 ? hint : nextId;
    const finalManifest = finalId === nextId ? manifest : buildManifest(finalId);
    const finalRaw = JSON.stringify(finalManifest);
    if (finalId !== nextId) {
      const v2 = await api("/agents/validate", { manifestRaw: finalRaw });
      console.log("re-validate:", JSON.stringify(v2, null, 2));
      state.manifestHash = v2.manifestHash;
    } else {
      state.manifestHash = v.manifestHash;
    }
    const localHash = ethers.keccak256(ethers.toUtf8Bytes(finalRaw));
    console.log("local hash :", localHash);
    console.log("hash match :", String(state.manifestHash).toLowerCase() === localHash.toLowerCase());
    state.agentId = finalId;
    fs.writeFileSync(MANIFEST_FILE, finalRaw); // 원문 바이트 그대로 보존 (해시 = 이 파일)
    saveState();
    console.log(`saved manifest.json (agentId=${finalId}) + state`);
    return;
  }

  if (cmd === "register") {
    if (!state.agentId || !state.manifestHash) throw new Error("run validate first");
    if (state.txHash) { console.log("already registered:", state.txHash); return; }
    const raw = fs.readFileSync(MANIFEST_FILE, "utf8");
    const manifest = JSON.parse(raw);
    const localHash = ethers.keccak256(ethers.toUtf8Bytes(raw));
    if (localHash.toLowerCase() !== String(state.manifestHash).toLowerCase()) throw new Error("hash drift, re-run validate");
    const onchainNext = Number(await registry.nextAgentId());
    if (onchainNext !== state.agentId) throw new Error(`nextAgentId moved: ${onchainNext} != ${state.agentId}, re-run validate`);
    const tx = await registry.registerAgent(manifest.endpoint, state.manifestHash, manifest.onchainType);
    console.log("tx sent:", tx.hash);
    const rc = await tx.wait();
    const ev = rc.logs.map((l) => { try { return registry.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "AgentRegistered");
    console.log("AgentRegistered agentId:", ev ? ev.args.agentId.toString() : "?", "owner:", ev ? ev.args.owner : "?");
    if (Number(ev?.args.agentId) !== state.agentId) throw new Error("agentId mismatch on-chain");
    state.txHash = rc.hash;
    saveState();
    console.log("on-chain registration confirmed:", rc.hash);
    return;
  }

  if (cmd === "submit") {
    if (!state.agentId || !state.manifestHash || !state.txHash) throw new Error("run register first");
    const manifestRaw = fs.readFileSync(MANIFEST_FILE, "utf8");
    const deadline = Math.floor(Date.now() / 1000) + 300;
    const domain = { name: "Pabal Agent Registration", version: "1", chainId, verifyingContract: C.AgentRegistry };
    const signature = await wallet.signTypedData(domain, AGENT_REGISTRATION_TYPES, {
      agentId: state.agentId, manifestHash: state.manifestHash, deadline,
    });
    const res = await api("/agents", { manifestRaw, signature, deadline });
    console.log("broker accepted:", JSON.stringify(res, null, 2));
    state.brokerRegistered = true;
    saveState();
    return;
  }

  if (cmd === "update") {
    if (!state.agentId) throw new Error("agentId not in state");
    const manifestRaw = fs.readFileSync(MANIFEST_FILE, "utf8");
    const newHash = ethers.keccak256(ethers.toUtf8Bytes(manifestRaw));
    const onchain = await registry.agents(state.agentId);
    if (onchain.manifestHash.toLowerCase() === newHash.toLowerCase()) {
      console.log("on-chain hash already matches, skipping updateAgent tx");
    } else {
      const metadataURI = onchain.metadataURI || ENDPOINT;
      const tx = await registry.updateAgent(state.agentId, metadataURI, newHash);
      console.log("updateAgent tx sent:", tx.hash);
      await tx.wait();
    }
    state.manifestHash = newHash;
    const deadline = Math.floor(Date.now() / 1000) + 300;
    const domain = { name: "Pabal Agent Registration", version: "1", chainId, verifyingContract: C.AgentRegistry };
    const signature = await wallet.signTypedData(domain, AGENT_REGISTRATION_TYPES, {
      agentId: state.agentId, manifestHash: newHash, deadline,
    });
    const res = await api("/agents", { manifestRaw, signature, deadline });
    console.log("broker resubmit:", JSON.stringify(res, null, 2));
    state.brokerRegistered = true;
    saveState();
    return;
  }

  if (cmd === "pricing") {
    if (!state.agentId) throw new Error("run validate first");
    const sub = ethers.parseUnits(process.argv[3] || "10", 6);
    const task = ethers.parseUnits(process.argv[4] || "1", 6);
    const tx = await hub.setPricing(state.agentId, sub, task);
    await tx.wait();
    console.log(`pricing set for #${state.agentId}: sub=${sub} task=${task} tx=${tx.hash}`);
    return;
  }

  if (cmd === "credits") {
    const usdt = new ethers.Contract(C.MockUSDT, USDT_ABI, wallet);
    const amt = ethers.parseUnits(process.argv[3] || "20", 6);
    await (await usdt.mint(wallet.address, amt)).wait();
    await (await usdt.approve(C.PaymentHub, amt)).wait();
    await (await hub.depositCredits(amt)).wait();
    console.log("credits:", (await hub.credits(wallet.address)).toString());
    return;
  }

  // 볼트 전용: 온체인 1회 집행 한도 = manifest maxUsdtPerTask와 일치시킨다
  if (cmd === "cap") {
    if (!state.agentId) throw new Error("run validate first");
    const cap = ethers.parseUnits(process.argv[3] || String(MAX_USDT_PER_TASK), 6);
    const tx = await vault.setMaxPerExecution(state.agentId, cap);
    await tx.wait();
    console.log(`maxPerExecution #${state.agentId} =`, ethers.formatUnits(await vault.maxPerExecution(state.agentId), 6), "USDT | tx:", tx.hash);
    return;
  }

  // 테스트 유저(=이 지갑) 예치: MockUSDT 민트 -> approve -> deposit(riskAckHash)
  if (cmd === "deposit") {
    if (!state.agentId) throw new Error("run validate first");
    const usdt = new ethers.Contract(C.MockUSDT, USDT_ABI, wallet);
    const amt = ethers.parseUnits(process.argv[3] || "30", 6);
    const riskAckHash = ethers.keccak256(ethers.toUtf8Bytes(RISK_NOTICE));
    await (await usdt.mint(wallet.address, amt)).wait();
    await (await usdt.approve(C.StrategyVault, amt)).wait();
    const tx = await vault.deposit(state.agentId, amt, riskAckHash);
    await tx.wait();
    const p = await vault.positions(state.agentId, wallet.address);
    console.log(`deposited ${ethers.formatUnits(amt, 6)} USDT | position: ${ethers.formatUnits(p.usdtBalance, 6)} USDT / ${ethers.formatUnits(p.dogeBalance, 8)} DOGE | tx: ${tx.hash}`);
    return;
  }

  if (cmd === "position") {
    if (!state.agentId) throw new Error("run validate first");
    const p = await vault.positions(state.agentId, wallet.address);
    console.log(`position #${state.agentId} ${wallet.address}: ${ethers.formatUnits(p.usdtBalance, 6)} USDT / ${ethers.formatUnits(p.dogeBalance, 8)} DOGE`);
    return;
  }

  if (cmd === "withdraw") {
    if (!state.agentId) throw new Error("run validate first");
    const tx = await vault.withdraw(state.agentId);
    await tx.wait();
    const p = await vault.positions(state.agentId, wallet.address);
    console.log(`withdrawn | position now: ${ethers.formatUnits(p.usdtBalance, 6)} USDT / ${ethers.formatUnits(p.dogeBalance, 8)} DOGE | tx: ${tx.hash}`);
    return;
  }

  if (cmd === "task") {
    if (!state.agentId) throw new Error("run validate first");
    const action = process.argv[3] || "dca.execute";
    const request = { action };
    if (process.argv[4] === "sim") request.simulate = "overheated";
    else if (process.argv[4] === "demo") request.demoStep = true; // 간격 미도래여도 데모 1회 집행
    else if (process.argv[4]) request.usdtAmount = Number(process.argv[4]);
    const requestHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(request)));
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const deadline = Math.floor(Date.now() / 1000) + 120;
    const auth = { broker: mp.auth.broker, user: wallet.address, agentId: state.agentId, requestHash, nonce, deadline };
    const domain = { name: mp.auth.domainName, version: mp.auth.domainVersion, chainId, verifyingContract: mp.auth.verifyingContract };
    const signature = await wallet.signTypedData(domain, TASK_REQUEST_TYPES, auth);
    const res = await api(`/task/${state.agentId}`, { user: wallet.address, request, auth, signature });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  throw new Error(`unknown cmd: ${cmd}`);
})().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
