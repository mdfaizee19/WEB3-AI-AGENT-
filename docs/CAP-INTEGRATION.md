# CAP Integration Guide

## What is CAP?

The **CROO Agent Protocol (CAP)** is an on-chain agent marketplace running on Base mainnet. It lets AI agents offer paid services — users pay in USDC, agents deliver structured results. Think of it as an API marketplace where payment and routing are handled by smart contracts rather than API keys.

CAP operates over a WebSocket connection to the CROO network. Each agent registers one or more **services** in the CROO Dashboard, gets a service ID, and then listens for incoming work via the WebSocket event stream.

---

## How Attestr Integrates with CAP

Attestr's coordinator (`src/coordinator/index.ts`) is a single long-running Node.js process that acts as the CAP agent for all four services simultaneously. It connects to the CROO WebSocket and dispatches incoming orders to the appropriate pipeline based on the service ID.

```
CROO Agent Store
      │
      │  User selects a service, pays USDC
      ▼
CROO Network (Base mainnet)
      │
      │  WebSocket events
      ▼
Attestr Coordinator (Railway, 24/7)
      │
      ├── CROO_SERVICE_ID_RESEARCH      → webResearch + verifySources + synthesize
      ├── CROO_SERVICE_ID_RISK_CHECK    → gatherAddressContext + analyzeRisk
      ├── CROO_SERVICE_ID_DUE_DILIGENCE → research + risk in parallel
      └── CROO_SERVICE_ID_HYPERLIQUID   → Hyperliquid API + Groq
```

---

## Service IDs and Routing

Each service is registered in the CROO Dashboard and assigned a unique service ID. These IDs are stored in `.env` and used by the coordinator to route incoming orders:

| Service | Env var | Pipeline |
|---|---|---|
| Web3 Research | `CROO_SERVICE_ID_RESEARCH` | `runResearchPipeline` |
| Contract Risk | `CROO_SERVICE_ID_RISK_CHECK` | `runRiskPipeline` |
| Due Diligence | `CROO_SERVICE_ID_DUE_DILIGENCE` | `runDueDiligencePipeline` |
| Hyperliquid Vault | `CROO_SERVICE_ID_HYPERLIQUID` | `runHyperliquidPipeline` |

The routing logic in `src/coordinator/index.ts`:

```typescript
if (serviceId === RESEARCH_SVC) {
  result = await runResearchPipeline(parseResearchRequest(requirements));
} else if (serviceId === RISK_SVC || serviceId === RISK_AGENT_SVC) {
  result = await runRiskPipeline(parseRiskRequest(requirements));
} else if (serviceId === DD_SVC) {
  result = await runDueDiligencePipeline(requirements);
} else if (serviceId === HL_SVC) {
  result = await runHyperliquidPipeline(JSON.parse(requirements));
}
```

---

## WebSocket Connection Flow

The coordinator uses `@croo-network/sdk`'s `AgentClient` to manage the WebSocket lifecycle:

```typescript
const client = new AgentClient(CROO_CONFIG, requireEnv('CROO_SDK_KEY_COORDINATOR'));
const stream = await client.connectWebSocket();
```

`CROO_CONFIG` points to:
- `CROO_API_URL=https://api.croo.network`
- `CROO_WS_URL=wss://api.croo.network/ws`

The process connects once on startup and keeps the WebSocket open indefinitely. Railway's always-on hosting keeps it alive 24/7.

---

## CAP Lifecycle

```
NegotiationCreated
       │
       ▼  client.acceptNegotiation(negotiation_id)
   Order created on-chain (USDC locked)
       │
       ▼  User pays
   OrderPaid event fired
       │
       ▼  Pipeline runs (research / risk / due diligence / vault)
   client.deliverOrder(orderId, { deliverableType: Text, deliverableText: JSON })
       │
       ▼  CROO releases USDC to agent
   Complete
```

If the pipeline fails, the coordinator calls `client.rejectOrder(orderId, reason)` to release the user's funds.

### Event handlers

**`NegotiationCreated`** — accept immediately, store the requirements string keyed by order ID:

```typescript
stream.on(EventType.NegotiationCreated, async (e) => {
  const result = await client.acceptNegotiation(e.negotiation_id!);
  userOrders.set(result.order.orderId, {
    requirements: result.negotiation.requirements,
    serviceId: result.negotiation.serviceId,
  });
});
```

**`OrderPaid`** — retrieve stored requirements, run the correct pipeline, deliver:

```typescript
stream.on(EventType.OrderPaid, async (e) => {
  const { requirements, serviceId } = userOrders.get(e.order_id!)!;
  userOrders.delete(e.order_id!);
  // ... run pipeline ...
  await client.deliverOrder(orderId, {
    deliverableType: DeliverableType.Text,
    deliverableText: JSON.stringify(result),
  });
});
```

---

## Research Pipeline (sequential)

The research pipeline runs three stages in sequence:

```
Stage 1: webResearch(query)
    └─ POST https://google.serper.dev/search
    └─ Returns: { query, findings: Finding[], searchedAt }

Stage 2: verifySources(urls)
    └─ HTTP HEAD each URL (8s timeout, parallel)
    └─ Returns: { results: VerificationResult[], verifiedAt }

Stage 3: synthesize({ task, webResearch, verification })
    └─ POST https://api.groq.com/openai/v1/chat/completions
    └─ Model: llama-3.3-70b-versatile
    └─ Returns: { executiveSummary, keyFindings, riskAssessment,
                  recommendations, confidenceScore, verifiedSources,
                  unverifiedSources, report }
```

If Groq fails, stage 3 falls back to a deterministic snippet-join so the pipeline never leaves a user order undelivered.

---

## Due Diligence Pipeline (parallel)

Research and risk analysis run in parallel when an address is present in the query:

```typescript
const [research, risk] = await Promise.all([
  runResearchPipeline({ query: req.query }),
  req.address
    ? runRiskPipeline({ address: req.address, chainId: req.chainId })
    : Promise.resolve(null),
]);
```

The coordinator then merges both results into a single markdown report with an `overallConfidence` score:

```
overallConfidence = (research.confidenceScore + (100 - risk.riskScore)) / 2
```

---

## Requirements Format

Requirements are passed as JSON strings in the CAP `requirements` field. Parsers in `src/coordinator/index.ts` handle both structured JSON and plain strings:

**Research:**
```json
{ "query": "Is Uniswap V4 safe?", "maxSources": 6 }
```
or plain string: `"Is Uniswap V4 safe?"`

**Risk:**
```json
{ "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "chainId": 8453 }
```
or plain string containing an address: `"Check 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"`

**Due Diligence:**
```json
{ "query": "Is Aave V3 safe on Base?", "address": "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" }
```

**Hyperliquid Vault:**
```json
{ "vaultAddress": "0x010461C14e146ac35Fe42271BDC1134EE31C703a" }
```

---

## Testing with the CROO Agent Store

1. Register your services in the [CROO Dashboard](https://app.croo.network)
2. Get your `CROO_SDK_KEY_COORDINATOR` and service IDs
3. Add them to `.env`
4. Start the coordinator: `npm run start:coordinator`
5. Find your services in the CROO Agent Store
6. Submit a test query and pay the USDC fee
7. Watch the coordinator logs — you'll see `accepted negotiation`, `order paid`, and `delivered` in sequence

---

## Running the Coordinator

```bash
npm run start:coordinator
# or
ts-node src/coordinator/index.ts
```

The coordinator logs all lifecycle events to stdout:

```
[coordinator] online — services: research | risk_check | due_diligence | hyperliquid_vault
[coordinator] accepted negotiation → order abc123 (service: svc-xxx)
[coordinator] order paid: abc123 (service: svc-xxx)
[coordinator] research pipeline: "Is Uniswap V4 safe?"
[coordinator] web research: 6 findings
[coordinator] source verification: 5/6 accessible
[coordinator] synthesis complete: confidence=78/100
[coordinator] delivered research result for order abc123
```
