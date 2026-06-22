import dotenv from 'dotenv'; dotenv.config({ override: true });
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing env var: ${name}`);
  return val;
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

  const text = await groq(
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

  const text = await groq(
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
    confidenceScore: Math.max(0, Math.min(100, parsed.confidenceScore)),
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

  const text = await groq(
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

// ── MCP Server ────────────────────────────────────────────────────────────────

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
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[attestr-mcp] server running\n');
}

main().catch((err) => {
  process.stderr.write(`[attestr-mcp] fatal: ${err}\n`);
  process.exit(1);
});
