# BUG Smart DCA — non-custodial DCA vault agent (Pabal/BOBOO, GIWA Sepolia)

An **external-creator AI agent** live on the [Pabal/BOBOO marketplace](https://test.pabal.ai) as **Agent #12**,
built and registered entirely through the marketplace's public creator flow (no platform-side code changes).

Users deposit test USDT into the platform's non-custodial `StrategyVault`; each round the agent's
AI gate reads the live BTC market (4H RSI(14) + daily SMA200 regime, from sibling
[Agent #9](https://github.com/bug4city/pabal-signal-agent)) and decides **GO or SKIP**.
Executed rounds swap the declared amount on-chain via the platform broker.

- **Live endpoint**: https://pabal-dca-agent.vercel.app (Vercel icn1, stateless)
- **On-chain**: GIWA Sepolia (chainId 91342), owner `0xFA225dDafEd6513DE41b040CB539e94D0F68570C`
  - Registration tx `0xc95bbb8655d0c1b99a9beeec7416917182844ddc5e3fbae24a6176ca9fbc35a6`
  - Live execution receipts: #22–24, 29, 31, 32 on the marketplace `ReceiptLog`
- **Trust tier**: `verified` (3+ successful executions, 3+ unique executors), subscriptions enabled

## Why it is non-custodial

The agent never holds keys or funds. All safety is enforced by the platform's on-chain vault:

1. **Withdrawals go only to the depositor address** — there is no code path to any other destination.
2. **On-chain per-execution cap** (`maxPerExecution`, 10 USDT here) — the final defense line even if the agent or broker misbehaves.
3. The agent returns an **execution proposal only**; the broker re-validates policy and executes.
4. Deposits require an explicit **risk-acknowledgement hash**.

## Architecture

```
launchd (30 min) ─► runner.js ── dca.plan ──► agent endpoint ── BTC RSI/regime ──► GO / SKIP
                        │ (go=true)                                    (from Agent #9)
                        └─ EIP-712 TaskRequest ─► broker /task/12 ─► agent dca.execute (proposal)
                                                        │
                                                        └─► StrategyVault.executeDca (on-chain, capped)
                                                            + ReceiptLog receipt
```

The live broker treats vault agents as **declarative primitives**: the proposal amount must equal the
manifest's `strategy.perExecutionUsdt` and rounds are rate-limited by `strategy.intervalSec` (1h).
So the AI's discretion lives in *timing*: the runner asks `dca.plan` first and simply does not submit
a task on overheated rounds (RSI ≥ 65) — no wasted fees, no rejected receipts.

## Try it (no wallet needed)

```bash
# What is this agent?
curl https://pabal-dca-agent.vercel.app/

# AI gate decision for the current market (live BTC RSI + regime)
curl -X POST https://pabal-dca-agent.vercel.app/ -H 'content-type: application/json' \
  -d '{"action":"dca.plan"}'

# Force the overheated branch to see a SKIP decision
curl -X POST https://pabal-dca-agent.vercel.app/ -H 'content-type: application/json' \
  -d '{"action":"dca.plan","simulate":"overheated"}'

# Read a live vault position (owner wallet shown as example)
curl -X POST https://pabal-dca-agent.vercel.app/ -H 'content-type: application/json' \
  -d '{"action":"dca.status","agentId":12,"user":"0xFA225dDafEd6513DE41b040CB539e94D0F68570C"}'
```

## Try it with your own wallet (full user flow)

Requires GIWA Sepolia test ETH: https://faucet.giwa.io

```bash
npm install
cp .env.example .env   # put PRIVATE_KEY=0x... (never committed)

node register.js status        # wallet / agent / pricing overview
node register.js credits 20    # mint MockUSDT -> deposit task credits (pays 1 USDT per task)
node register.js deposit 30    # mint -> approve -> vault deposit (with risk-ack hash)
node register.js task dca.execute   # EIP-712 signed task -> broker executes on-chain
node register.js position      # your vault position (USDT remaining / DOGE accumulated)
node register.js withdraw      # everything back to YOUR address - the only exit path
```

`node register.js task dca.execute` again within the hour returns `not_due` — the interval gate.

## The bot (autonomous runner)

[`runner/runner.js`](runner/runner.js) is the full autonomous loop we soak-tested
(3 consecutive launchd cycles: EXECUTED → NOT_DUE → EXECUTED, receipts #31/#32):
per cycle it calls `dca.plan`, skips on `go=false`, otherwise signs an EIP-712 TaskRequest
and submits it. File-only logging, EPIPE-safe, alert hook on repeated failures.
`runner/com.bug.pabal-dca-runner.plist.example` shows the macOS launchd setup.

## Files

| File | What |
|---|---|
| `api/index.js` | Agent endpoint (`dca.plan` / `dca.execute` / `dca.status`), stateless |
| `register.js` | Creator + user CLI: validate → register (on-chain) → submit (EIP-712) → pricing / cap / deposit / task / withdraw |
| `manifest.json` | Registered manifest (raw bytes = on-chain `manifestHash`) |
| `runner/` | Autonomous bot loop + launchd example |

## Disclosure

GIWA Sepolia testnet demo. The vault swap is a fixed-rate simulation into MockDOGE
(a real DEX/oracle-priced WBTC path is the planned v2 and requires a platform-side vault upgrade).
Not real assets, not investment advice.
