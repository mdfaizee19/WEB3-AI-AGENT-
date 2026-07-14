import dotenv from 'dotenv'; dotenv.config({ override: true });
import http from 'http';
import { randomBytes, timingSafeEqual } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { AgentClient } from '@croo-network/sdk';
import { CROO_CONFIG } from '../config';

const PORT = Number(process.env.PORT ?? 3001);
const SERVER_URL = (process.env.SERVER_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '');

// ── Helpers ───────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  return process.env[name] ?? '';
}

function extractJson(text: string): string {
  const stripped = text.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  const json = start !== -1 && end > start ? stripped.slice(start, end + 1) : stripped;
  return json.replace(/"(?:[^"\\]|\\.)*"/g, (m) =>
    m.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t'),
  );
}

async function groq(systemPrompt: string, userPrompt: string): Promise<string> {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${requireEnv('GROQ_API_KEY')}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Groq error: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return data.choices[0]?.message?.content ?? '';
}

async function groqJson(systemPrompt: string, userPrompt: string): Promise<string> {
  const jsonInstruction = '\n\nIMPORTANT: Return ONLY valid JSON. No text before or after. No markdown code blocks. Start your response with { and end with }';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const sys = attempt === 1
      ? systemPrompt + jsonInstruction
      : systemPrompt + jsonInstruction + `\n\nCRITICAL (attempt ${attempt}/3): Your previous response was not valid JSON. Output ONLY a JSON object starting with { — nothing else.`;
    const text = await groq(sys, userPrompt);
    try {
      JSON.parse(extractJson(text));
      return text;
    } catch {
      process.stderr.write(`[attestr-mcp] groq returned non-JSON (attempt ${attempt}/3): ${text.slice(0, 150)}\n`);
      if (attempt === 3) throw new Error(`Groq returned non-JSON after 3 attempts: ${text.slice(0, 200)}`);
    }
  }
  throw new Error('unreachable');
}

// ── Tool 1: check_contract_risk ───────────────────────────────────────────────

interface EtherscanResponse<T> { status: string; result: T }
interface EthTx { from: string; to: string; value: string; isError: string; functionName: string }
interface TokenTx { tokenSymbol: string; tokenName: string; contractAddress: string }
interface ContractSource { ContractName: string; CompilerVersion: string; SourceCode: string; Proxy: string; Implementation: string }

async function fetchExplorer<T>(params: Record<string, string>, chainId = 8453): Promise<T | null> {
  const url = new URL('https://api.etherscan.io/v2/api');
  url.searchParams.set('chainid', String(chainId));
  url.searchParams.set('apikey', requireEnv('ETHERSCAN_API_KEY'));
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url.toString(), { signal: controller.signal });
    clearTimeout(timer);
    const data = (await res.json()) as EtherscanResponse<T>;
    return data.status === '1' ? data.result : null;
  } catch { return null; }
}

async function checkContractRisk(address: string): Promise<object> {
  const [balance, txList, tokenTxs, sourceCode] = await Promise.allSettled([
    fetchExplorer<string>({ module: 'account', action: 'balance', address, tag: 'latest' }),
    fetchExplorer<EthTx[]>({ module: 'account', action: 'txlist', address, sort: 'desc', page: '1', offset: '25' }),
    fetchExplorer<TokenTx[]>({ module: 'account', action: 'tokentx', address, sort: 'desc', page: '1', offset: '25' }),
    fetchExplorer<ContractSource[]>({ module: 'contract', action: 'getsourcecode', address }),
  ]);

  const lines: string[] = [`Address: ${address}`, 'Chain: Base (chainId: 8453)', ''];

  if (balance.status === 'fulfilled' && balance.value !== null) {
    lines.push(`Native Balance: ${(Number(BigInt(balance.value as string)) / 1e18).toFixed(6)} ETH`);
  }

  const src = sourceCode.status === 'fulfilled' ? (sourceCode.value as ContractSource[])?.[0] : null;
  if (src?.ContractName) {
    lines.push(`Type: Contract — ${src.ContractName}`, `Compiler: ${src.CompilerVersion}`, `Source verified: ${src.SourceCode ? 'Yes' : 'No'}`);
    if (src.Proxy === '1') lines.push(`Proxy: Yes (implementation: ${src.Implementation})`);
  } else {
    lines.push('Type: EOA (externally owned account)');
  }

  if (txList.status === 'fulfilled' && Array.isArray(txList.value)) {
    const txs = txList.value as EthTx[];
    const failed = txs.filter((t) => t.isError === '1').length;
    const outgoing = txs.filter((t) => t.from.toLowerCase() === address.toLowerCase()).length;
    lines.push(`\nTransaction history (last ${txs.length}): ${outgoing} outgoing, ${txs.length - outgoing} incoming, ${failed} failed`);
    for (const tx of txs.slice(0, 12)) {
      const dir = tx.from.toLowerCase() === address.toLowerCase() ? 'OUT' : 'IN ';
      lines.push(`  ${dir} ${(Number(tx.value) / 1e18).toFixed(6)} ETH → ${tx.to}${tx.functionName ? ` [${tx.functionName.split('(')[0]}]` : ''}${tx.isError === '1' ? ' (FAILED)' : ''}`);
    }
  }

  if (tokenTxs.status === 'fulfilled' && Array.isArray(tokenTxs.value)) {
    const unique = [...new Map((tokenTxs.value as TokenTx[]).map((t) => [t.contractAddress, t])).values()];
    lines.push(`\nToken interactions (${unique.length} unique):`);
    for (const t of unique.slice(0, 10)) lines.push(`  ${t.tokenSymbol} (${t.tokenName}) — ${t.contractAddress}`);
  }

  const text = await groqJson(
    'You are a blockchain security expert. Produce calibrated, accurate risk scores — not conservative over-scoring.',
    `On-chain data:\n${lines.join('\n')}\n\nReturn JSON: {"badge":"SAFE"|"CAUTION"|"DANGEROUS","riskScore":0,"reasons":["..."],"report":"..."}\n0-30=SAFE,31-65=CAUTION,66-100=DANGEROUS. No markdown fences.`,
  );
  const parsed = JSON.parse(extractJson(text)) as { badge: string; riskScore: number; reasons: string[]; report: string };
  return {
    address,
    badge: parsed.badge,
    riskScore: Math.max(0, Math.min(100, parsed.riskScore)),
    reasons: parsed.reasons,
    report: parsed.report,
    analyzedAt: new Date().toISOString(),
  };
}

// ── Tool 2: research_web3 ─────────────────────────────────────────────────────

interface SerperResult { title: string; link: string; snippet: string; source?: string }

async function researchWeb3(query: string): Promise<object> {
  const serperRes = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': requireEnv('SERPER_API_KEY') },
    body: JSON.stringify({ q: query, num: 6 }),
  });
  if (!serperRes.ok) throw new Error(`Serper error: ${serperRes.status}`);
  const data = (await serperRes.json()) as { organic?: SerperResult[] };
  const findings = (data.organic ?? []).slice(0, 6).map((f) => ({
    title: f.title, url: f.link, snippet: f.snippet,
    source: f.source ?? new URL(f.link).hostname,
  }));

  const verified = await Promise.all(findings.map(async (f) => {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 8000);
      const r = await fetch(f.url, { method: 'HEAD', signal: c.signal, redirect: 'follow', headers: { 'User-Agent': 'Attestr/1.0' } });
      clearTimeout(t);
      return { url: f.url, ok: r.status < 400 };
    } catch { return { url: f.url, ok: false }; }
  }));
  const verifiedUrls = new Set(verified.filter((v) => v.ok).map((v) => v.url));
  const vf = findings.filter((f) => verifiedUrls.has(f.url));
  const uf = findings.filter((f) => !verifiedUrls.has(f.url));
  const ordered = [...vf, ...uf];

  const findingsText = ordered.map((f, i) => {
    const s = verifiedUrls.has(f.url) ? '✓ verified' : '⚠ unverified';
    return `[${i + 1}] ${f.title} (${s})\nSource: ${f.url}\n${f.snippet}`;
  }).join('\n\n');

  const text = await groqJson(
    'You are a Web3 Intelligence analyst specializing in DeFi research and smart contract analysis.',
    `Query: "${query}"\n\nFindings (${vf.length} verified, ${uf.length} unverified):\n\n${findingsText || 'No findings.'}\n\nReturn JSON: {"executiveSummary":"...","keyFindings":["..."],"riskAssessment":"...","recommendations":["..."],"confidenceScore":0,"report":"..."}\nNo markdown fences.`,
  );
  const parsed = JSON.parse(extractJson(text)) as {
    executiveSummary: string; keyFindings: string[]; riskAssessment: string;
    recommendations: string[]; confidenceScore: number; report: string;
  };
  return {
    query,
    executiveSummary: parsed.executiveSummary,
    keyFindings: parsed.keyFindings,
    riskAssessment: parsed.riskAssessment,
    recommendations: parsed.recommendations,
    confidenceScore: Math.max(0, Math.min(100, parsed.confidenceScore < 1 ? parsed.confidenceScore * 100 : parsed.confidenceScore)),
    verifiedSources: [...verifiedUrls],
    unverifiedSources: uf.map((f) => f.url),
    report: parsed.report,
    synthesizedAt: new Date().toISOString(),
  };
}

// ── Tool 3: analyze_hyperliquid_vault ─────────────────────────────────────────

interface HLVaultFollower { user: string; vaultEquity: string }
interface HLVaultPortfolioEntry { accountValueHistory: [number, string][] }
interface HLVault {
  name: string; leader: string; apr: number;
  leaderCommission: number; isClosed: boolean; allowDeposits: boolean;
  followers: HLVaultFollower[];
  maxDistributable: number;
  portfolio: [string, HLVaultPortfolioEntry][];
}

async function analyzeHyperliquidVault(vaultAddress: string): Promise<object> {
  const res = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'vaultDetails', vaultAddress }),
  });
  if (!res.ok) throw new Error(`Hyperliquid API error: ${res.status}`);
  const vault = (await res.json()) as HLVault;

  // TVL: latest accountValueHistory entry across portfolio periods
  let tvl = 0;
  for (const [, entry] of vault.portfolio ?? []) {
    const hist = entry?.accountValueHistory ?? [];
    if (hist.length > 0) {
      const latest = parseFloat(hist[hist.length - 1][1]);
      if (latest > tvl) tvl = latest;
    }
  }

  const apr = vault.apr ?? 0;
  const commission = vault.leaderCommission ?? 0;
  const followers = Array.isArray(vault.followers) ? vault.followers.length : 0;
  // Hyperliquid does not expose a maxFollowers cap; use maxDistributable as capacity proxy
  const maxFollowers = 0;

  const text = await groqJson(
    'You are a DeFi analyst specializing in Hyperliquid vault strategies. Provide calibrated, accurate risk assessments.',
    `Hyperliquid Vault:
Name: ${vault.name}
Address: ${vaultAddress}
Leader: ${vault.leader}
TVL: $${tvl.toLocaleString()}
APR: ${apr}%
Commission: ${commission}%
Followers: ${followers}
Allow Deposits: ${vault.allowDeposits ? 'Yes' : 'No'}
Closed: ${vault.isClosed ? 'Yes' : 'No'}

RISK SIGNALS:
- APR >200%: unsustainable/high leverage risk
- TVL <$10K: manipulation risk
- Commission >20%: significantly reduces net returns
- >90% capacity: liquidity/exit risk
- Closed vault: no new deposits possible

Return JSON: {"badge":"SAFE"|"CAUTION"|"DANGEROUS","riskScore":0,"tvlUsd":0,"apr":0,"commission":0,"followers":0,"maxFollowers":0,"capacityPct":0,"riskFactors":["..."],"depositRecommendation":"YES"|"NO","recommendationReason":"...","report":"..."}
0-30=SAFE+YES, 31-65=CAUTION+NO unless strong APR justifies, 66-100=DANGEROUS+NO. No markdown fences.`,
  );
  const parsed = JSON.parse(extractJson(text)) as {
    badge: string; riskScore: number; riskFactors: string[];
    depositRecommendation: string; recommendationReason: string; report: string;
  };
  return {
    vaultAddress,
    name: vault.name,
    leader: vault.leader,
    tvlUsd: tvl,
    apr,
    commission,
    followers,
    allowDeposits: vault.allowDeposits,
    isClosed: vault.isClosed,
    badge: parsed.badge,
    riskScore: Math.max(0, Math.min(100, parsed.riskScore)),
    riskFactors: parsed.riskFactors,
    depositRecommendation: parsed.depositRecommendation,
    recommendationReason: parsed.recommendationReason,
    report: parsed.report,
    analyzedAt: new Date().toISOString(),
  };
}

// ── Tool 4: full_due_diligence ────────────────────────────────────────────────

async function fullDueDiligence(query: string): Promise<object> {
  const research = await researchWeb3(query) as {
    executiveSummary: string; keyFindings: string[];
    riskAssessment: string; recommendations: string[];
    confidenceScore: number; verifiedSources: string[];
    unverifiedSources: string[]; report: string;
  };

  const ETH_RE = /0x[0-9a-fA-F]{40}/;
  const addressMatch = ETH_RE.exec(query);
  let risk: object | null = null;
  if (addressMatch) {
    risk = await checkContractRisk(addressMatch[0]);
  }

  const riskResult = risk as { riskScore?: number; badge?: string; reasons?: string[]; report?: string } | null;
  const overallConfidence = riskResult
    ? Math.round((research.confidenceScore + (100 - (riskResult.riskScore ?? 50))) / 2)
    : research.confidenceScore;

  const combinedReport = [
    '# Due Diligence Report',
    '',
    `**Query:** ${query}`,
    `**Overall Confidence:** ${overallConfidence}/100`,
    '',
    '---',
    '',
    '## Research Findings',
    '',
    research.report,
    '',
    '---',
    '',
    riskResult ? [
      '## Risk Analysis',
      '',
      `**Badge:** ${riskResult.badge} | **Score:** ${riskResult.riskScore}/100`,
      '',
      '**Risk Factors:**',
      ...(riskResult.reasons ?? []).map((r) => `- ${r}`),
      '',
      riskResult.report ?? '',
    ].join('\n') : '## Risk Analysis\n\nNo contract address detected — risk analysis skipped.',
    '',
    '---',
    '',
    '## Combined Assessment',
    '',
    `**Research confidence:** ${research.confidenceScore}/100`,
    riskResult ? `**Risk score:** ${riskResult.riskScore}/100 — ${riskResult.badge}` : '',
    `**Overall confidence:** ${overallConfidence}/100`,
    '',
    '### Key Findings',
    ...research.keyFindings.map((f) => `- ${f}`),
    '',
    '### Recommendations',
    ...research.recommendations.map((r) => `- ${r}`),
  ].filter((l) => l !== undefined).join('\n');

  return {
    query,
    research,
    risk,
    overallConfidence,
    combinedReport,
    analyzedAt: new Date().toISOString(),
  };
}

// ── Tool 5: get_agent_status ──────────────────────────────────────────────────

async function getAgentStatus(): Promise<object> {
  const coordinatorUrl = (process.env['COORDINATOR_URL'] ?? '').replace(/\/$/, '');
  const dashboardSecret = process.env['DASHBOARD_SECRET'] ?? '';

  if (!coordinatorUrl) {
    return { error: 'COORDINATOR_URL not configured on this MCP server' };
  }

  const res = await fetch(`${coordinatorUrl}/health`, {
    headers: { Authorization: `Bearer ${dashboardSecret}` },
    signal: AbortSignal.timeout(8000),
  });

  if (res.status === 401) return { error: 'Coordinator returned 401 — check DASHBOARD_SECRET' };
  if (!res.ok) return { error: `Coordinator returned ${res.status}` };

  const data = (await res.json()) as {
    status: string; uptimeSeconds: number; startedAt: string;
    activeOrders: number; services: string[];
  };

  const uptimeSec = data.uptimeSeconds ?? 0;
  const h = Math.floor(uptimeSec / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  const s = uptimeSec % 60;
  const uptimeHuman = h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;

  return {
    status: data.status,
    uptime: uptimeHuman,
    uptimeSeconds: data.uptimeSeconds,
    startedAt: data.startedAt,
    activeOrders: data.activeOrders,
    services: data.services,
    checkedAt: new Date().toISOString(),
  };
}

// ── Tool 6: list_orders ───────────────────────────────────────────────────────

const SERVICE_LABELS: Record<string, string> = {
  [process.env['CROO_SERVICE_ID_RESEARCH'] ?? '']: 'Research Query',
  [process.env['CROO_SERVICE_ID_RISK_CHECK'] ?? '']: 'Contract Risk Check',
  [process.env['CROO_SERVICE_ID_RISK'] ?? '']: 'Risk Agent',
  [process.env['CROO_SERVICE_ID_DUE_DILIGENCE'] ?? '']: 'Full Due Diligence',
  [process.env['CROO_SERVICE_ID_HYPERLIQUID'] ?? '']: 'Hyperliquid Vault',
};

async function listAgentOrders(status?: string): Promise<object> {
  const sdkKey = process.env['CROO_SDK_KEY_COORDINATOR'] ?? '';
  if (!sdkKey) return { error: 'CROO_SDK_KEY_COORDINATOR not configured on this MCP server' };

  const client = new AgentClient(CROO_CONFIG, sdkKey);
  const filter: Record<string, string> = { role: 'provider' };
  if (status) filter['status'] = status;

  const raw = await client.listOrders(filter as Parameters<typeof client.listOrders>[0]);
  const list: unknown[] = Array.isArray(raw) ? raw : ((raw as { orders?: unknown[] }).orders ?? []);

  const orders = list.map((o) => {
    const order = o as Record<string, unknown>;
    const svcId = typeof order['serviceId'] === 'string' ? order['serviceId'] : '';
    return {
      orderId: order['orderId'],
      serviceName: SERVICE_LABELS[svcId] || svcId,
      status: order['status'],
      createdAt: order['createdAt'],
      price: order['price'] ?? order['amount'] ?? null,
    };
  }).sort((a, b) =>
    new Date(String(b.createdAt ?? 0)).getTime() - new Date(String(a.createdAt ?? 0)).getTime()
  );

  return {
    total: orders.length,
    orders,
    fetchedAt: new Date().toISOString(),
  };
}

// ── MCP Server factory ────────────────────────────────────────────────────────
// Creates a fresh Server instance with all 4 tools registered.
// Called once per stateless /mcp request so each request is fully independent.

function createMcpServer(): Server {
  const server = new Server(
    { name: 'attestr', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'check_contract_risk',
        description: 'Analyze a contract or wallet address on Base mainnet. Returns SAFE/CAUTION/DANGEROUS badge, risk score 0-100, and a detailed risk report.',
        inputSchema: {
          type: 'object',
          properties: {
            address: { type: 'string', description: 'Ethereum address (0x...) to analyze' },
          },
          required: ['address'],
        },
      },
      {
        name: 'research_web3',
        description: 'Research any Web3 / DeFi topic using live web search + source verification + AI synthesis. Returns a structured intelligence report with confidence score.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Research question or topic' },
          },
          required: ['query'],
        },
      },
      {
        name: 'analyze_hyperliquid_vault',
        description: 'Analyze a Hyperliquid vault. Returns TVL, APR, commission, capacity, risk score, and a YES/NO deposit recommendation.',
        inputSchema: {
          type: 'object',
          properties: {
            vault_address: { type: 'string', description: 'Hyperliquid vault address (0x...)' },
          },
          required: ['vault_address'],
        },
      },
      {
        name: 'full_due_diligence',
        description: 'Run a complete due diligence: web research + contract risk analysis (if an address is in the query) combined into one report.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Research query — include a contract address to trigger risk analysis' },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_agent_status',
        description: 'Check whether the Attestr coordinator agent is online on Railway. Returns status (online/offline), uptime, number of active orders being processed, and list of active services.',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'list_orders',
        description: 'List orders received by the Attestr agent on the CROO network. Returns order history with service name, status, and timestamp. Optionally filter by status (negotiating, paid, delivered, rejected, cancelled).',
        inputSchema: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              description: 'Optional status filter: negotiating | paid | delivered | rejected | cancelled',
              enum: ['negotiating', 'paid', 'delivered', 'rejected', 'cancelled'],
            },
          },
          required: [],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      let result: object;
      if (name === 'check_contract_risk') {
        const { address } = args as { address: string };
        if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`Invalid address: ${address}`);
        result = await checkContractRisk(address);
      } else if (name === 'research_web3') {
        const { query } = args as { query: string };
        result = await researchWeb3(query);
      } else if (name === 'analyze_hyperliquid_vault') {
        const { vault_address } = args as { vault_address: string };
        if (!/^0x[0-9a-fA-F]{40}$/.test(vault_address)) throw new Error(`Invalid vault address: ${vault_address}`);
        result = await analyzeHyperliquidVault(vault_address);
      } else if (name === 'full_due_diligence') {
        const { query } = args as { query: string };
        result = await fullDueDiligence(query);
      } else if (name === 'get_agent_status') {
        result = await getAgentStatus();
      } else if (name === 'list_orders') {
        const { status } = args as { status?: string };
        result = await listAgentOrders(status);
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  });

  return server;
}

// ── OAuth / auth helpers ──────────────────────────────────────────────────────

function getApiKey(): string {
  return requireEnv('MCP_API_KEY');
}

// Short-lived single-use auth codes: code → { expiresAt, used }
interface AuthCodeEntry { expiresAt: number; used: boolean }
const authCodes = new Map<string, AuthCodeEntry>();

function generateAuthCode(): string {
  const code = randomBytes(32).toString('base64url');
  authCodes.set(code, { expiresAt: Date.now() + 60_000, used: false });
  // Prune expired entries
  for (const [k, v] of authCodes) if (v.expiresAt < Date.now()) authCodes.delete(k);
  return code;
}

function consumeAuthCode(code: string): boolean {
  const entry = authCodes.get(code);
  if (!entry || entry.used || entry.expiresAt < Date.now()) {
    authCodes.delete(code);
    return false;
  }
  authCodes.delete(code);
  return true;
}

// Constant-time string comparison — returns false on length mismatch without comparing
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Validate redirect_uri: exact match against OAUTH_REDIRECT_URI allowlist, or require https
function validateRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    const allowed = process.env.OAUTH_REDIRECT_URI;
    if (allowed) {
      const a = new URL(allowed);
      return u.protocol === a.protocol && u.host === a.host && u.pathname === a.pathname;
    }
    // No allowlist: require https; allow http for localhost only
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true;
    return false;
  } catch { return false; }
}

function validateBearer(req: http.IncomingMessage): boolean {
  const auth = req.headers['authorization'] ?? '';
  const [scheme, token] = auth.split(' ');
  if (scheme !== 'Bearer' || !token) return false;
  const key = getApiKey();
  if (!key) return false; // fail closed: MCP_API_KEY not configured
  return safeEqual(token, key);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(payload);
}

function html(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

// ── HTTP request router ───────────────────────────────────────────────────────

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', SERVER_URL);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // CORS pre-flight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, mcp-session-id',
    });
    res.end();
    return;
  }

  // ── OAuth 2.0 AS metadata ─────────────────────────────────────────────────
  if (path === '/.well-known/oauth-authorization-server') {
    json(res, 200, {
      issuer: SERVER_URL,
      authorization_endpoint: `${SERVER_URL}/oauth/authorize`,
      token_endpoint: `${SERVER_URL}/oauth/token`,
      registration_endpoint: `${SERVER_URL}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
      code_challenge_methods_supported: ['S256', 'plain'],
    });
    return;
  }

  // ── RFC 7591 dynamic client registration ─────────────────────────────────
  if (path === '/oauth/register' && method === 'POST') {
    const body = await readBody(req);
    let redirectUris: string[] = [];
    try {
      const parsed = JSON.parse(body) as { redirect_uris?: string[] };
      redirectUris = Array.isArray(parsed.redirect_uris) ? parsed.redirect_uris : [];
    } catch { /* ignore malformed body */ }
    json(res, 201, {
      client_id: 'claude-ai-client',
      client_secret: 'not-required',
      redirect_uris: redirectUris,
      grant_types: ['authorization_code'],
      token_endpoint_auth_method: 'none',
    });
    return;
  }

  // ── Authorization endpoint — simple API-key form ──────────────────────────
  if (path === '/oauth/authorize' && method === 'GET') {
    const redirectUri = url.searchParams.get('redirect_uri') ?? '';
    const state = url.searchParams.get('state') ?? '';
    const clientId = url.searchParams.get('client_id') ?? '';
    if (!validateRedirectUri(redirectUri)) {
      html(res, 400, '<h1>Invalid redirect_uri</h1><p>The redirect URI is not permitted.</p>');
      return;
    }
    html(res, 200, `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Attestr MCP — Connect</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
    .card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:40px;max-width:420px;width:100%;box-shadow:0 2px 8px rgba(0,0,0,.06)}
    h1{font-size:1.25rem;font-weight:700;color:#0f172a;margin-bottom:6px}
    p{font-size:.875rem;color:#64748b;margin-bottom:24px;line-height:1.5}
    label{display:block;font-size:.8rem;font-weight:600;color:#334155;margin-bottom:6px;letter-spacing:.04em;text-transform:uppercase}
    input{display:block;width:100%;padding:10px 14px;border:1px solid #cbd5e1;border-radius:8px;font-size:.875rem;font-family:monospace;color:#0f172a;outline:none;margin-bottom:20px}
    input:focus{border-color:#0077B6;box-shadow:0 0 0 3px rgba(0,119,182,.15)}
    button{display:block;width:100%;padding:11px;background:#0077B6;color:#fff;border:none;border-radius:8px;font-size:.875rem;font-weight:700;cursor:pointer;letter-spacing:.02em}
    button:hover{background:#005f8f}
    .logo{font-weight:900;font-size:1rem;color:#0077B6;letter-spacing:.06em;margin-bottom:24px}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">ATTESTR</div>
    <h1>Connect to Claude.ai</h1>
    <p>Enter your Attestr API key to grant Claude.ai access to the Web3 intelligence tools.</p>
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="redirect_uri" value="${encodeURIComponent(redirectUri)}">
      <input type="hidden" name="state" value="${encodeURIComponent(state)}">
      <input type="hidden" name="client_id" value="${encodeURIComponent(clientId)}">
      <label for="key">API Key</label>
      <input id="key" type="password" name="api_key" placeholder="Enter your MCP_API_KEY" autocomplete="off" required>
      <button type="submit">Authorize →</button>
    </form>
  </div>
</body>
</html>`);
    return;
  }

  // ── Authorization form submission ─────────────────────────────────────────
  if (path === '/oauth/authorize' && method === 'POST') {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const apiKey = params.get('api_key') ?? '';
    const redirectUri = decodeURIComponent(params.get('redirect_uri') ?? '');
    const state = decodeURIComponent(params.get('state') ?? '');

    // Validate redirect_uri before credential check to avoid oracle leakage
    if (!validateRedirectUri(redirectUri)) {
      html(res, 400, '<h1>Invalid redirect_uri</h1><p>The redirect URI is not permitted.</p>');
      return;
    }

    const serverKey = getApiKey();
    if (!serverKey || !safeEqual(apiKey, serverKey)) {
      html(res, 401, '<h1>Invalid API key</h1><p>Go back and try again.</p>');
      return;
    }

    // Issue a short-lived opaque code — NOT the raw API key
    const code = generateAuthCode();
    const redirectUrl = new URL(redirectUri);
    redirectUrl.searchParams.set('code', code);
    if (state) redirectUrl.searchParams.set('state', state);
    res.writeHead(302, { Location: redirectUrl.toString() });
    res.end();
    return;
  }

  // ── Token endpoint — exchange code for bearer token ───────────────────────
  if (path === '/oauth/token' && method === 'POST') {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const grantType = params.get('grant_type');
    const code = params.get('code') ?? '';

    if (grantType !== 'authorization_code' || !consumeAuthCode(code)) {
      json(res, 400, { error: 'invalid_grant', error_description: 'Invalid or expired authorization code' });
      return;
    }

    json(res, 200, {
      access_token: getApiKey(),
      token_type: 'bearer',
      expires_in: 86400,
      scope: 'mcp',
    });
    return;
  }

  // ── MCP endpoint — bearer validation + stateless transport ───────────────
  if (path === '/mcp') {
    if (!validateBearer(req)) {
      res.writeHead(401, {
        'WWW-Authenticate': `Bearer realm="${SERVER_URL}", error="invalid_token"`,
        'Content-Type': 'application/json',
      });
      res.end(JSON.stringify({ error: 'invalid_token', error_description: 'Valid Bearer token required' }));
      return;
    }

    let body: unknown;
    if (method === 'POST') {
      const raw = await readBody(req);
      try { body = JSON.parse(raw); } catch { body = raw; }
    }

    // Stateless: new Server + transport per request
    const mcpServer = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }

  // ── Health check / root ───────────────────────────────────────────────────
  if (path === '/' || path === '/health') {
    json(res, 200, { status: 'ok', server: 'attestr-mcp', version: '1.0.0' });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
}

// ── Start HTTP server ─────────────────────────────────────────────────────────

async function main() {
  const httpServer = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      process.stderr.write(`[attestr-mcp] request error: ${err}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal_server_error' }));
      }
    });
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    process.stderr.write(`[attestr-mcp] HTTP server listening on port ${PORT}\n`);
    process.stderr.write(`[attestr-mcp] MCP endpoint:    ${SERVER_URL}/mcp\n`);
    process.stderr.write(`[attestr-mcp] OAuth metadata:  ${SERVER_URL}/.well-known/oauth-authorization-server\n`);
    process.stderr.write(`[attestr-mcp] Connect in Claude.ai → Settings → Integrations → Add MCP Server\n`);
    process.stderr.write(`[attestr-mcp] Server URL: ${SERVER_URL}\n`);
  });
}

main().catch((err) => {
  process.stderr.write(`[attestr-mcp] fatal: ${err}\n`);
  process.exit(1);
});
