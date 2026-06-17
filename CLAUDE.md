# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run each agent (each must run in its own terminal)
npm run start:coordinator
npm run start:web-research
npm run start:source-verification
npm run start:synthesis

# Type-check / compile
npm run build
```

There are no tests. `ts-node` is used for development; `tsc` compiles to `dist/`.

## Environment setup

Copy `.env.example` to `.env` and fill in:
- `CROO_SDK_KEY_*` — one key per agent, obtained from the CROO Dashboard
- `CROO_SERVICE_ID_*` — service IDs assigned when registering each specialist agent in the CROO Dashboard
- `ANTHROPIC_API_KEY` — used by the Synthesis agent to call `claude-sonnet-4-6`

## Architecture

Attestr is a Web3 Intelligence Network for DeFi research and smart contract analysis — a 4-process multi-agent system on the CROO Agent Protocol (CAP) over Base mainnet, paid in USDC. Each agent is a long-running Node process that connects to the CROO WebSocket and responds to CAP lifecycle events.

### CAP lifecycle

```
negotiate → accept (on-chain order created) → pay → deliver → complete
```

All inter-agent communication flows through the CROO network — agents never call each other directly. The coordinator plays **two roles** simultaneously:

- **Provider** for users: accepts incoming `NegotiationCreated` events from users, waits for `OrderPaid`, then runs the pipeline and calls `deliverOrder`.
- **Requester** for sub-agents: calls `negotiateOrder` on each sub-agent service, pays when `OrderCreated` fires, waits for `OrderCompleted`, then calls `getDelivery`.

### Coordinator state tracking

The coordinator uses three in-memory Maps to route async events to the right handlers:

| Map | Key | Value | Purpose |
|-----|-----|-------|---------|
| `userOrders` | `order_id` | requirements string | Tracks accepted user orders so `OrderPaid` can retrieve the task without an extra API call |
| `pendingNegotiations` | `negotiation_id` | `{resolve, reject}` | Routes `OrderCreated` / `NegotiationRejected` to the right sub-agent call |
| `pendingOrders` | `order_id` | `{resolve, reject}` | Routes `OrderCompleted` / `OrderRejected` / `OrderExpired` to the right sub-agent call |

`callSubAgent()` in `src/coordinator/index.ts` wraps all of this in a single Promise with nested timeouts (5 min each for negotiation and delivery).

### Research pipeline (sequential)

1. **Web Research** (`CROO_SERVICE_ID_WEB_RESEARCH`) — queries DuckDuckGo Instant Answer API; returns `WebResearchResult` with `Finding[]`
2. **Source Verification** (`CROO_SERVICE_ID_SOURCE_VERIFICATION`) — HTTP HEAD checks all URLs from step 1; returns `SourceVerificationResult`
3. **Synthesis** (`CROO_SERVICE_ID_SYNTHESIS`) — calls `claude-sonnet-4-6` with a Web3 analyst system prompt; falls back to deterministic join if the API call fails

Requirements and deliverables are passed as JSON strings over the CAP `requirements` / `deliverableText` fields.

### Synthesis agent — Claude integration

`src/agents/synthesis/index.ts` uses `@anthropic-ai/sdk` to call `claude-sonnet-4-6`. The system prompt positions Claude as a Web3/DeFi analyst. It asks Claude to return a JSON object `{ summary, keyFindings }` directly (no markdown fences). If the API call throws or returns unparseable JSON, the agent falls back to a deterministic snippet-join so the pipeline never fails.

### Shared types

`src/types.ts` defines all shared interfaces (`ResearchTask`, `WebResearchResult`, `SourceVerificationResult`, `SynthesisInput`, `SynthesisResult`). `src/config.ts` exports `CROO_CONFIG` (base/ws URLs) and `requireEnv()`.

### Adding a new agent

1. Create `src/agents/<name>/index.ts` — follow the same pattern: connect WS, handle `NegotiationCreated` (accept) and `OrderPaid` (fetch order+negotiation, process, deliver).
2. Register the service in the CROO Dashboard to get a service ID.
3. Add `CROO_SDK_KEY_<NAME>` and `CROO_SERVICE_ID_<NAME>` to `.env`.
4. Add a `start:<name>` script to `package.json`.
5. Wire the coordinator to call `callSubAgent(requireEnv('CROO_SERVICE_ID_<NAME>'), ...)` in `runPipeline`.
