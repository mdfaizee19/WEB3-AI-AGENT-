# MCP Integration Guide

## What is MCP?

The **Model Context Protocol (MCP)** is an open standard from Anthropic that lets AI assistants (Claude.ai, Claude Code, Claude Desktop) call external tools over HTTP. Instead of copy-pasting data into a chat window, Claude connects directly to an MCP server and calls its tools on demand.

Attestr's MCP server (`src/mcp/index.ts`) runs as an HTTP server with OAuth 2.0 authentication, making it compatible with Claude.ai's remote MCP connector — no local installation required.

**MCP Server URL:** `https://attestr-mcp-production.up.railway.app`

---

## 6 Available Tools

### 1. `check_contract_risk`

Analyzes any contract or wallet address on Base mainnet. Fetches on-chain data from Etherscan v2 (balance, transaction history, token interactions, source code) and returns a calibrated risk score from Groq.

**Input:**
```json
{ "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }
```

**Output:**
```json
{
  "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "badge": "SAFE",
  "riskScore": 10,
  "reasons": [
    "Verified source code (FiatTokenProxy)",
    "Standard ERC-20 proxy pattern",
    "No failed transactions"
  ],
  "report": "## Risk Summary\n\nThis is the USDC contract on Base...",
  "analyzedAt": "2025-01-15T10:30:00.000Z"
}
```

Badge is one of `SAFE` (0–30), `CAUTION` (31–65), or `DANGEROUS` (66–100).

---

### 2. `research_web3`

Searches the web for any DeFi or Web3 topic using Serper (Google Search), verifies that sources are live, and synthesizes findings into a structured intelligence report using Groq.

**Input:**
```json
{ "query": "What are the risks of Uniswap V4 hooks?" }
```

**Output:**
```json
{
  "query": "What are the risks of Uniswap V4 hooks?",
  "executiveSummary": "Uniswap V4 hooks introduce programmable pool logic...",
  "keyFindings": [
    "Hooks can manipulate price oracles if poorly audited",
    "Malicious hooks can drain liquidity under specific conditions"
  ],
  "riskAssessment": "Medium risk for hook-enabled pools without audits...",
  "recommendations": [
    "Only interact with audited hook contracts",
    "Check hook address against known allowlists"
  ],
  "confidenceScore": 82,
  "verifiedSources": ["https://uniswap.org/..."],
  "unverifiedSources": [],
  "report": "## Executive Summary\n\n...",
  "synthesizedAt": "2025-01-15T10:31:00.000Z"
}
```

`confidenceScore` is 0–100 based on the number of verified sources.

---

### 3. `analyze_hyperliquid_vault`

Fetches live vault data from the Hyperliquid API and returns a risk-scored analysis with a clear YES/NO deposit recommendation.

**Input:**
```json
{ "vault_address": "0x010461C14e146ac35Fe42271BDC1134EE31C703a" }
```

**Output:**
```json
{
  "vaultAddress": "0x010461C14e146ac35Fe42271BDC1134EE31C703a",
  "name": "HLP",
  "leader": "0xabc...",
  "tvlUsd": 420000,
  "apr": 18.5,
  "commission": 10,
  "followers": 142,
  "allowDeposits": true,
  "isClosed": false,
  "badge": "SAFE",
  "riskScore": 22,
  "riskFactors": ["Commission at 10% reduces net returns"],
  "depositRecommendation": "YES",
  "recommendationReason": "Established vault with sustainable APR and verified TVL",
  "report": "## Vault Overview\n\n...",
  "analyzedAt": "2025-01-15T10:32:00.000Z"
}
```

Risk signals evaluated: APR > 200%, TVL < $10K, commission > 20%, vault closed.

---

### 4. `full_due_diligence`

Runs research and contract risk analysis together, then combines them into a single due diligence report with an overall confidence score. If the query contains an Ethereum address, risk analysis runs automatically.

**Input:**
```json
{ "query": "Is Aave V3 safe on Base? 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" }
```

**Output:**
```json
{
  "query": "Is Aave V3 safe on Base? ...",
  "overallConfidence": 85,
  "combinedReport": "# Due Diligence Report\n\n## Research Findings\n\n...\n\n## Risk Analysis\n\n...",
  "research": { "...": "full research result" },
  "risk": { "badge": "SAFE", "riskScore": 12, "...": "..." },
  "analyzedAt": "2025-01-15T10:33:00.000Z"
}
```

`overallConfidence = (research.confidenceScore + (100 − risk.riskScore)) / 2`

---

### 5. `get_agent_status`

Checks whether the Attestr coordinator (the CAP backend that takes orders from the CROO network) is online, and reports uptime and active order count. Calls the coordinator's `/health` endpoint over Railway's private network, authenticated with `DASHBOARD_SECRET`.

**Input:** none

**Output:**
```json
{
  "status": "online",
  "uptime": "2h 14m 3s",
  "uptimeSeconds": 8043,
  "startedAt": "2026-07-15T01:28:58.982Z",
  "activeOrders": 0,
  "services": ["Research Query", "Contract Risk Check", "Full Due Diligence", "Hyperliquid Vault"],
  "checkedAt": "2026-07-15T03:42:11.000Z"
}
```

If `COORDINATOR_URL` isn't configured, or the coordinator returns 401, this tool returns a descriptive `error` field instead of throwing — check `DASHBOARD_SECRET` matches on both services.

---

### 6. `list_orders`

Lists orders received by the coordinator on the CROO network, most recent first, with human-readable service names (mapped from `CROO_SERVICE_ID_*`). Calls the CROO API directly via `@croo-network/sdk`, authenticated with `CROO_SDK_KEY_COORDINATOR` — independent of the coordinator's own uptime.

**Input:**
```json
{ "status": "paid" }
```
`status` is optional: `negotiating | paid | delivered | rejected | cancelled`. Omit it to list all orders.

**Output:**
```json
{
  "total": 2,
  "orders": [
    { "orderId": "3a1816d3-...", "serviceName": "Contract Risk Check", "status": "completed", "createdAt": "2026-07-14T09:39:59Z", "price": null },
    { "orderId": "254ff4df-...", "serviceName": "Hyperliquid Vault", "status": "rejected", "createdAt": "2026-07-14T03:18:17Z", "price": null }
  ],
  "fetchedAt": "2026-07-15T03:42:30.000Z"
}
```

`price` is currently `null`/empty for all orders — the CROO API doesn't populate a price or amount field on order records yet.

---

## Connect to Claude.ai

The easiest way — no local setup needed.

1. Go to **Claude.ai → Settings → Integrations → Add MCP Server**
2. Enter the server URL **including the `/mcp` path**: `https://attestr-mcp-production.up.railway.app/mcp` — Claude.ai sends protocol calls directly to whatever URL you enter here, it does not discover `/mcp` on its own. Entering the bare domain will authorize successfully but then fail to connect with "Attestr returned an error."
3. Claude.ai fetches `/.well-known/oauth-authorization-server` and starts the OAuth flow
4. You are redirected to the Attestr authorization page
5. Enter your `MCP_API_KEY` and click **Authorize**
6. Claude.ai stores the bearer token and connects to `/mcp`

All 6 tools now appear in Claude.ai automatically. Ask Claude: *"What MCP tools do you have?"* to confirm.

---

## Connect to Claude Code

### Option A — HTTP transport (remote server, no local install)

```bash
claude mcp add attestr --transport http https://attestr-mcp-production.up.railway.app/mcp
```

Add the bearer token to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "attestr": {
      "type": "http",
      "url": "https://attestr-mcp-production.up.railway.app/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_API_KEY"
      }
    }
  }
}
```

### Option B — Local stdio (run the server yourself)

1. Clone the repo and install dependencies:
```bash
git clone https://github.com/mdfaizee19/ATTESTR-CROO.git
cd ATTESTR-CROO
npm install
cp .env.example .env   # fill in your API keys
```

2. Add to your project's `.mcp.json`:
```json
{
  "mcpServers": {
    "attestr": {
      "command": "npx",
      "args": ["ts-node", "src/mcp/index.ts"],
      "cwd": "/path/to/ATTESTR-CROO"
    }
  }
}
```

---

## OAuth API Key Setup

The MCP server uses a simple API-key OAuth flow compliant with RFC 8414 and RFC 7591.

**Flow:**
```
Claude.ai
  → GET /.well-known/oauth-authorization-server   (discover endpoints)
  → POST /oauth/register                           (RFC 7591 dynamic registration)
  → GET /oauth/authorize?redirect_uri=...         (show login form)
  → POST /oauth/authorize  { api_key: MCP_API_KEY } (validate key, issue 60s code)
  → POST /oauth/token  { code: <opaque-code> }    (exchange code → bearer token)
  → POST /mcp  Authorization: Bearer <token>      (tool calls)
```

**Security properties:**
- The authorization code is a random 32-byte `base64url` string — not the API key itself
- Codes expire in 60 seconds and are single-use
- `redirect_uri` is validated against `OAUTH_REDIRECT_URI` allowlist (or must be `https://`)
- Bearer validation uses `crypto.timingSafeEqual` to prevent timing attacks
- If `MCP_API_KEY` is not set, all auth requests are rejected (fail closed)

**Generate a strong API key:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Set it in your `.env`:
```
MCP_API_KEY=your_generated_key_here
```

---

## Running the MCP Server Locally

```bash
# Start HTTP MCP server (OAuth + all 6 tools)
npm run mcp:http

# Server listens on port 3001 by default
# Set PORT env var to change

# For Claude.ai access, tunnel with ngrok:
ngrok http 3001
# Then set SERVER_URL=https://xxxx.ngrok.io in .env
```

Startup log:
```
[attestr-mcp] HTTP server listening on port 3001
[attestr-mcp] MCP endpoint:   http://localhost:3001/mcp
[attestr-mcp] OAuth metadata: http://localhost:3001/.well-known/oauth-authorization-server
```

---

## Required Environment Variables

| Variable | Required | Description |
|---|---|---|
| `MCP_API_KEY` | Yes | Bearer token secret — generate with `crypto.randomBytes(32).toString('hex')` |
| `GROQ_API_KEY` | Yes | Groq API key — used by 4 of the 6 tools for AI synthesis |
| `SERPER_API_KEY` | For research tools | Serper Google Search API key |
| `ETHERSCAN_API_KEY` | For risk tools | Etherscan v2 API key |
| `SERVER_URL` | For Claude.ai | Public URL of the MCP server (Railway or ngrok) |
| `PORT` | No | HTTP port (default: `3001`) |
| `OAUTH_REDIRECT_URI` | No | Exact callback URL allowlist (e.g. `https://claude.ai/api/mcp/auth_callback`) |
| `COORDINATOR_URL` | For `get_agent_status` | Coordinator's internal URL, e.g. `http://attestrcroo.railway.internal:8080` (use Railway private networking, not a public domain) |
| `DASHBOARD_SECRET` | For `get_agent_status` | Shared secret — must match the same variable set on the coordinator service |
| `CROO_SDK_KEY_COORDINATOR` | For `list_orders` | CROO SDK key — same one the coordinator uses to authenticate to the CROO API |
| `CROO_SERVICE_ID_*` | Optional | Service IDs used to map order `serviceId` to a human-readable name in `list_orders` output |

---

## MCP Endpoints Reference

| Method | Path | Description |
|---|---|---|
| `GET` | `/.well-known/oauth-authorization-server` | RFC 8414 AS metadata |
| `POST` | `/oauth/register` | RFC 7591 dynamic client registration |
| `GET` | `/oauth/authorize` | Authorization form (enter API key) |
| `POST` | `/oauth/authorize` | Submit API key, receive redirect with code |
| `POST` | `/oauth/token` | Exchange code for bearer token |
| `POST` | `/mcp` | MCP tool calls (requires `Authorization: Bearer`) |
| `GET` | `/health` | Health check → `{ status: "ok" }` |
| `GET` | `/` | Same as `/health` (Railway health probe) |
