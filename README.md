# Attestr — Web3 Intelligence Network

Attestr is a multi-agent DeFi research and smart contract analysis platform. It combines live web search, on-chain data, and AI synthesis into actionable intelligence — accessible via Claude.ai, Claude Code, and the CROO Agent Store.

**Live URLs**

| Service | URL |
|---|---|
| Frontend | https://attestr-frontend.vercel.app |
| MCP Server | https://attestrmcp-production.up.railway.app |
| Backend (CAP) | Railway — 24/7 |

---

## What Attestr Does

Attestr exposes four intelligence services, paid in USDC via the CROO Agent Protocol (CAP):

| Service | What it does | Pricing |
|---|---|---|
| **Web3 Research** | Live Google search + source verification + AI synthesis → structured report | Per query, in USDC |
| **Contract Risk** | On-chain analysis via Etherscan (Base) → SAFE / CAUTION / DANGEROUS badge + score/100 | Per address, in USDC |
| **Due Diligence** | Research + risk in parallel → combined markdown report + overall confidence score | Per query, in USDC |
| **Hyperliquid Vault** | Vault TVL, APR, commission, capacity → YES/NO deposit recommendation + risk score | Per vault, in USDC |

Prices are configured in the CROO Dashboard per service. All payments settle on Base mainnet in USDC.

---

## Quick Start

### Connect via Claude.ai (recommended)

1. Go to **Claude.ai → Settings → Integrations → Add MCP Server**
2. Enter: `https://attestrmcp-production.up.railway.app`
3. Claude.ai will redirect you to the OAuth authorization page
4. Enter your `MCP_API_KEY` to grant access
5. All 4 tools are now available in Claude.ai

### Connect via Claude Code

```bash
claude mcp add attestr --transport http https://attestrmcp-production.up.railway.app/mcp
```

Set the `Authorization` header using your `MCP_API_KEY`:

```json
{
  "mcpServers": {
    "attestr": {
      "type": "http",
      "url": "https://attestrmcp-production.up.railway.app/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_API_KEY"
      }
    }
  }
}
```

### Run locally

```bash
git clone https://github.com/mdfaizee19/Attestr.CROO.git
cd Attestr.CROO
cp .env.example .env   # fill in your API keys
npm install
npm run mcp:http       # starts HTTP MCP server on port 3001
```

---

## Example Tool Calls

**Check if a contract is safe:**
```
check_contract_risk("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")
→ { badge: "SAFE", riskScore: 10, reasons: [...], report: "..." }
```

**Research a DeFi topic:**
```
research_web3("What are the risks of Uniswap V4 hooks?")
→ { executiveSummary, keyFindings, riskAssessment, confidenceScore: 82 }
```

**Analyze a Hyperliquid vault:**
```
analyze_hyperliquid_vault("0x010461C14e146ac35Fe42271BDC1134EE31C703a")
→ { tvlUsd: 420000, apr: 18.5, badge: "SAFE", depositRecommendation: "YES" }
```

**Full due diligence:**
```
full_due_diligence("Is Aave V3 safe on Base? 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5")
→ Combined report: research + on-chain risk + overall confidence score
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Agent protocol | CROO Agent Protocol (CAP) over Base mainnet |
| Payment | USDC on Base (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) |
| MCP transport | StreamableHTTP (RFC 8414 OAuth 2.0) |
| AI synthesis | Groq — `llama-3.3-70b-versatile` |
| Web search | Serper (Google Search API) |
| On-chain data | Etherscan v2 API (Base, chainId 8453) |
| Vault data | Hyperliquid REST API |
| Backend runtime | Node.js + TypeScript (`ts-node`) |
| Frontend | React + Vite, deployed on Vercel |
| Backend hosting | Railway (24/7) |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Users                                │
│          Claude.ai  ·  Claude Code  ·  CROO Agent Store     │
└────────────┬──────────────────────────────┬─────────────────┘
             │ MCP (HTTP + OAuth)            │ CAP (WebSocket + USDC)
             ▼                              ▼
┌─────────────────────┐        ┌─────────────────────────────┐
│   MCP Server        │        │   Coordinator               │
│   /mcp (HTTP)       │        │   src/coordinator/index.ts  │
│   Railway           │        │   Railway                   │
└────────┬────────────┘        └──────────────┬──────────────┘
         │                                    │
         │  Groq · Serper · Etherscan         │  Groq · Serper
         │  Hyperliquid                       │  Etherscan · Hyperliquid
         └──────────────┬─────────────────────┘
                        │
              ┌─────────▼──────────┐
              │   External APIs    │
              │  Groq  Serper      │
              │  Etherscan  HL     │
              └────────────────────┘
```

**MCP path:** Claude → OAuth → `/mcp` → tools run inline → response  
**CAP path:** User pays USDC on Base → `NegotiationCreated` → `OrderPaid` → pipeline runs → `deliverOrder`

---

## Folder Structure

```
Attestr/
├── src/
│   ├── coordinator/   # CAP backend — CROO WebSocket agent
│   │   └── index.ts
│   ├── mcp/           # MCP HTTP server — Claude.ai connector
│   │   └── index.ts
│   ├── config.ts      # CROO network config + requireEnv
│   └── types.ts       # Shared TypeScript interfaces
├── frontend/          # React landing page (Vercel)
├── docs/              # Integration guides
│   ├── CAP-INTEGRATION.md
│   └── MCP-INTEGRATION.md
├── .env.example       # Environment variable template
└── package.json
```

---

## Environment Variables

Copy `.env.example` to `.env`:

```bash
# AI providers
GROQ_API_KEY=          # Groq — AI synthesis
SERPER_API_KEY=        # Serper — web search
ETHERSCAN_API_KEY=     # Etherscan v2 — on-chain data

# MCP server
MCP_API_KEY=           # Bearer token for Claude.ai OAuth
SERVER_URL=            # Public URL (Railway or ngrok)
PORT=3001

# CROO (CAP backend only)
CROO_SDK_KEY_COORDINATOR=
CROO_SERVICE_ID_RESEARCH=
CROO_SERVICE_ID_RISK_CHECK=
CROO_SERVICE_ID_DUE_DILIGENCE=
CROO_SERVICE_ID_HYPERLIQUID=
```

See [docs/MCP-INTEGRATION.md](docs/MCP-INTEGRATION.md) for MCP setup and [docs/CAP-INTEGRATION.md](docs/CAP-INTEGRATION.md) for CAP/CROO integration.
