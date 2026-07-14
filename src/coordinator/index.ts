import dotenv from 'dotenv'; dotenv.config({ override: true });
import http from 'http';
import { AgentClient, EventType, DeliverableType, APIError } from '@croo-network/sdk';
import { CROO_CONFIG, requireEnv } from '../config';
import type {
  ResearchTask,
  Finding,
  WebResearchResult,
  VerificationResult,
  SourceVerificationResult,
  SynthesisInput,
  SynthesisResult,
  RiskAnalysisTask,
  RiskAnalysisResult,
  DueDiligenceRequest,
  DueDiligenceResult,
  HyperliquidVaultTask,
  HyperliquidVaultResult,
} from '../types';

// â”€â”€ Constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const ETH_ADDRESS_RE = /0x[0-9a-fA-F]{40}/;

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function extractJson(text: string): string {
  const stripped = text.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  const json = start !== -1 && end > start ? stripped.slice(start, end + 1) : stripped;
  // Escape raw control chars that Groq sometimes emits inside JSON string values
  return json.replace(/"(?:[^"\\]|\\.)*"/g, (match) =>
    match.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t'),
  );
}

async function groq(systemPrompt: string, userPrompt: string): Promise<string> {
  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${requireEnv('GROQ_API_KEY')}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Groq API error: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return data.choices[0]?.message?.content ?? '';
}

async function groqJson(systemPrompt: string, userPrompt: string): Promise<string> {
  const jsonInstruction = '\n\nIMPORTANT: Return ONLY valid JSON. No text before or after. No markdown code blocks. Start your response with { and end with }';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const sys = attempt === 1
      ? systemPrompt + jsonInstruction
      : systemPrompt + jsonInstruction + `\n\nCRITICAL (attempt ${attempt}/3): Your previous response was not valid JSON. Output ONLY a JSON object starting with { -- nothing else.`;
    const text = await groq(sys, userPrompt);
    try {
      JSON.parse(extractJson(text));
      return text;
    } catch {
      console.error(`[coordinator] groq returned non-JSON (attempt ${attempt}/3):`, text.slice(0, 150));
      if (attempt === 3) throw new Error(`Groq returned non-JSON after 3 attempts: ${text.slice(0, 200)}`);
    }
  }
  throw new Error('unreachable');
}

// â”€â”€ Stage 1: Web Research (Serper) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface SerperOrganicResult { title: string; link: string; snippet: string; source?: string }
interface SerperResponse { organic?: SerperOrganicResult[] }

async function webResearch(query: string, maxSources = 6): Promise<WebResearchResult> {
  const apiKey = requireEnv('SERPER_API_KEY');
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
    body: JSON.stringify({ q: query, num: maxSources }),
  });
  if (!res.ok) throw new Error(`Serper API error: ${res.status}`);
  const data = (await res.json()) as SerperResponse;
  const findings: Finding[] = (data.organic ?? []).slice(0, maxSources).map((item) => ({
    title: item.title,
    url: item.link,
    snippet: item.snippet,
    source: item.source ?? new URL(item.link).hostname,
  }));
  return { query, findings, searchedAt: new Date().toISOString() };
}

// â”€â”€ Stage 2: Source Verification â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function verifyUrl(url: string): Promise<VerificationResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: { 'User-Agent': 'Attestr-SourceVerifier/1.0' },
      redirect: 'follow',
    });
    clearTimeout(timer);
    return { url, isAccessible: res.status < 400, statusCode: res.status };
  } catch (err) {
    clearTimeout(timer);
    return { url, isAccessible: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function verifySources(urls: string[]): Promise<SourceVerificationResult> {
  const results = await Promise.all(urls.map(verifyUrl));
  return { results, verifiedAt: new Date().toISOString() };
}

// â”€â”€ Stage 3: Synthesis (Groq) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function synthesize(input: SynthesisInput): Promise<SynthesisResult> {
  const { task, webResearch: wr, verification } = input;

  const verifiedUrls = new Set(
    verification.results.filter((r) => r.isAccessible).map((r) => r.url),
  );
  const verifiedFindings = wr.findings.filter((f) => verifiedUrls.has(f.url));
  const unverifiedFindings = wr.findings.filter((f) => !verifiedUrls.has(f.url));
  const ordered = [...verifiedFindings, ...unverifiedFindings];

  const findingsText = ordered
    .map((f, i) => {
      const status = verifiedUrls.has(f.url) ? 'âœ“ verified' : 'âš  unverified';
      return `[${i + 1}] ${f.title} (${status})\nSource: ${f.url}\n${f.snippet}`;
    })
    .join('\n\n');

  const userPrompt = `Query: "${task.query}"

Research findings (${verifiedFindings.length} verified, ${unverifiedFindings.length} unverified):

${findingsText || 'No findings available.'}

Produce a structured intelligence report as a JSON object with exactly these fields:
{
  "executiveSummary": "<2-3 sentence high-level overview>",
  "keyFindings": ["<key insight 1>", "<key insight 2>", ...],
  "riskAssessment": "<paragraph covering risks, red flags, and security considerations>",
  "recommendations": ["<actionable recommendation 1>", ...],
  "confidenceScore": <integer 0-100 based on source quality: ${verifiedFindings.length} of ${ordered.length} sources verified>,
  "report": "<full markdown report with ## Executive Summary, ## Key Findings, ## Risk Assessment, ## Recommendations sections>"
}

Return only valid JSON. No markdown fences around the JSON itself.`;

  try {
    const text = await groqJson(
      'You are a Web3 Intelligence analyst specializing in DeFi research and smart contract analysis.',
      userPrompt,
    );
    const parsed = JSON.parse(extractJson(text)) as {
      executiveSummary: string;
      keyFindings: string[];
      riskAssessment: string;
      recommendations: string[];
      confidenceScore: number;
      report: string;
    };
    return {
      query: task.query,
      executiveSummary: parsed.executiveSummary,
      keyFindings: parsed.keyFindings,
      riskAssessment: parsed.riskAssessment,
      recommendations: parsed.recommendations,
      confidenceScore: Math.max(0, Math.min(100, parsed.confidenceScore < 1 ? parsed.confidenceScore * 100 : parsed.confidenceScore)),
      verifiedSources: [...verifiedUrls],
      unverifiedSources: unverifiedFindings.map((f) => f.url),
      report: parsed.report,
      synthesizedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error('[coordinator] synthesis groq call failed, using deterministic fallback:', err);
    const parts = ordered.slice(0, 3).map((f) => f.snippet).filter(Boolean);
    const executiveSummary = parts.join(' ').trim() || `No findings for: ${task.query}`;
    const keyFindings = ordered.slice(0, 5).map((f) => `[${f.source}] ${f.snippet || f.title}`).filter(Boolean);
    return {
      query: task.query,
      executiveSummary,
      keyFindings,
      riskAssessment: 'Risk assessment unavailable (AI synthesis failed).',
      recommendations: [],
      confidenceScore: verifiedFindings.length >= 2 ? 60 : verifiedFindings.length >= 1 ? 40 : 20,
      verifiedSources: [...verifiedUrls],
      unverifiedSources: unverifiedFindings.map((f) => f.url),
      report: `## ${task.query}\n\n${executiveSummary}`,
      synthesizedAt: new Date().toISOString(),
    };
  }
}

// â”€â”€ Stage 4: Risk Analysis (Etherscan/Basescan + Groq) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface EtherscanResponse<T> { status: string; message: string; result: T }
interface EthTx { from: string; to: string; value: string; isError: string; functionName: string }
interface TokenTx { tokenSymbol: string; tokenName: string; contractAddress: string }
interface ContractSource { ContractName: string; CompilerVersion: string; SourceCode: string; Proxy: string; Implementation: string }

async function fetchExplorer<T>(params: Record<string, string>, chainId: number): Promise<T | null> {
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
  } catch {
    return null;
  }
}

async function gatherAddressContext(address: string, chainId: number): Promise<string> {
  const [balance, txList, tokenTxs, sourceCode] = await Promise.allSettled([
    fetchExplorer<string>({ module: 'account', action: 'balance', address, tag: 'latest' }, chainId),
    fetchExplorer<EthTx[]>({ module: 'account', action: 'txlist', address, sort: 'desc', page: '1', offset: '25' }, chainId),
    fetchExplorer<TokenTx[]>({ module: 'account', action: 'tokentx', address, sort: 'desc', page: '1', offset: '25' }, chainId),
    fetchExplorer<ContractSource[]>({ module: 'contract', action: 'getsourcecode', address }, chainId),
  ]);

  const chainName = chainId === 8453 ? 'Base' : chainId === 137 ? 'Polygon' : 'Ethereum';
  const lines: string[] = [`Address: ${address}`, `Chain: ${chainName} (chainId: ${chainId})`, ''];

  if (balance.status === 'fulfilled' && balance.value !== null) {
    lines.push(`Native Balance: ${(Number(BigInt(balance.value as string)) / 1e18).toFixed(6)} ETH`);
  }

  const src = sourceCode.status === 'fulfilled' ? sourceCode.value?.[0] : null;
  if (src?.ContractName) {
    lines.push(`Type: Contract â€” ${src.ContractName}`);
    lines.push(`Compiler: ${src.CompilerVersion}`);
    lines.push(`Source verified: ${src.SourceCode ? 'Yes' : 'No'}`);
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
      const eth = (Number(tx.value) / 1e18).toFixed(6);
      const fn = tx.functionName ? ` [${tx.functionName.split('(')[0]}]` : '';
      lines.push(`  ${dir} ${eth} ETH â†' ${tx.to}${fn}${tx.isError === '1' ? ' (FAILED)' : ''}`);
    }
  }

  if (tokenTxs.status === 'fulfilled' && Array.isArray(tokenTxs.value)) {
    const tokens = tokenTxs.value as TokenTx[];
    const unique = [...new Map(tokens.map((t) => [t.contractAddress, t])).values()];
    lines.push(`\nToken interactions (${unique.length} unique):`);
    for (const t of unique.slice(0, 10)) lines.push(`  ${t.tokenSymbol} (${t.tokenName}) â€” ${t.contractAddress}`);
  }

  return lines.join('\n');
}

async function analyzeRisk(task: RiskAnalysisTask): Promise<RiskAnalysisResult> {
  const chainId = task.chainId ?? 1;
  const context = await gatherAddressContext(task.address, chainId);

  const userPrompt = `On-chain data:\n${context}

Analyze this address and produce a calibrated risk score. Use the following framework:

POSITIVE / LOW-RISK SIGNALS (reduce score):
- Verified source code: strong trust signal
- Proxy pattern (e.g. FiatTokenProxy, TransparentUpgradeableProxy, EIP-1967) on a verified contract: NORMAL for major tokens â€” not inherently risky
- Well-known contract naming conventions (FiatToken, USDC, USDT, WETH, UniswapV3Pool, etc.): treat as lower-risk unless other red flags exist
- Established, widely-used standards (ERC-20, ERC-721 with verified source): positive signal

NEUTRAL / CONTEXT-DEPENDENT:
- Proxy pattern alone: neutral â€” only flag as risky if ALSO unverified, anonymous, or very recently deployed
- Older compiler version: minor informational note, not a primary risk factor for audited contracts
- Missing transaction history for a contract address: normal â€” contracts don't send txs, users do

ACTUAL RED FLAGS (raise score significantly):
- Unverified or missing source code on a contract
- Contract deployed very recently (days/weeks ago) with no established usage
- Suspicious or obfuscated naming
- High transaction failure rate from an EOA
- Known drainer/mixer/scam patterns
- Mint functions with no supply caps, blacklist functions, or hidden owner controls in an unaudited contract
- EOA with large outflows to mixers or flagged addresses

Return a JSON object with exactly these fields:
{
  "badge": "SAFE" | "CAUTION" | "DANGEROUS",
  "riskScore": <integer 0-100>,
  "reasons": ["<specific, factual observation 1>", ...],
  "report": "<markdown risk report with ## Risk Summary, ## On-Chain Analysis, ## Risk Factors, ## Recommendations sections>"
}

Scoring guide: 0-30 â†' SAFE, 31-65 â†' CAUTION, 66-100 â†' DANGEROUS. Badge must match riskScore range.
A verified, named, proxy-pattern stablecoin contract with no anomalous on-chain behaviour should score in the SAFE range.
Return only valid JSON. No markdown fences.`;

  try {
    const text = await groqJson(
      'You are a blockchain security expert specializing in Ethereum and EVM chain risk analysis. Your goal is accurate, calibrated risk assessment â€” not conservative over-scoring. Well-known, verified, audited contracts should score low. Reserve high scores for genuine threats.',
      userPrompt,
    );
    const parsed = JSON.parse(extractJson(text)) as {
      badge: 'SAFE' | 'CAUTION' | 'DANGEROUS';
      riskScore: number;
      reasons: string[];
      report: string;
    };
    return {
      address: task.address,
      badge: parsed.badge,
      riskScore: Math.max(0, Math.min(100, parsed.riskScore)),
      reasons: parsed.reasons,
      report: parsed.report,
      analyzedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error('[coordinator] risk analysis failed after retries:', err);
    return {
      address: task.address,
      badge: 'CAUTION' as const,
      riskScore: 50,
      reasons: ['Risk analysis unavailable -- AI service returned non-JSON response'],
      report: '## Risk Analysis\n\nUnable to complete AI risk analysis. On-chain data was gathered but synthesis failed.',
      analyzedAt: new Date().toISOString(),
    };
  }
}

// â”€â”€ Request parsers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// CROO store wraps user input as {"text": "..."} -- unwrap before parsing
function unwrapText(requirements: string): string {
  try {
    const obj = JSON.parse(requirements) as Record<string, unknown>;
    if (obj && typeof obj.text === 'string') return obj.text;
  } catch { /* fall through */ }
  return requirements;
}

function parseResearchRequest(requirements: string): ResearchTask {
  const raw = unwrapText(requirements);
  let parsed: unknown = null;
  try { parsed = JSON.parse(raw); } catch { /* fall through */ }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.query === 'string') {
      return { query: obj.query, maxSources: typeof obj.maxSources === 'number' ? obj.maxSources : undefined };
    }
  }
  return { query: typeof parsed === 'string' ? parsed : raw };
}

function parseRiskRequest(requirements: string): RiskAnalysisTask {
  const raw = unwrapText(requirements);
  let parsed: unknown = null;
  try { parsed = JSON.parse(raw); } catch { /* fall through */ }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.address === 'string') {
      return { address: obj.address, chainId: typeof obj.chainId === 'number' ? obj.chainId : undefined };
    }
  }
  const plain = typeof parsed === 'string' ? parsed : raw;
  const match = ETH_ADDRESS_RE.exec(plain);
  if (match) return { address: match[0] };
  throw new Error(`No Ethereum address found in requirements: ${requirements}`);
}

function parseHyperliquidRequest(requirements: string): HyperliquidVaultTask {
  const raw = unwrapText(requirements);
  let parsed: unknown = null;
  try { parsed = JSON.parse(raw); } catch { /* fall through */ }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const addr = obj.vaultAddress ?? obj.address ?? obj.vault_address;
    if (typeof addr === 'string') return { vaultAddress: addr };
  }
  const plain = typeof parsed === 'string' ? parsed : raw;
  const match = ETH_ADDRESS_RE.exec(plain);
  if (match) return { vaultAddress: match[0] };
  throw new Error(`No vault address found in requirements: ${requirements}`);
}

function parseDueDiligenceRequest(requirements: string): DueDiligenceRequest {
  const raw = unwrapText(requirements);
  let parsed: unknown = null;
  try { parsed = JSON.parse(raw); } catch { /* fall through */ }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const query = typeof obj.query === 'string' ? obj.query : '';
    const address = typeof obj.address === 'string' && ETH_ADDRESS_RE.test(obj.address) ? obj.address : undefined;
    const chainId = typeof obj.chainId === 'number' ? obj.chainId : undefined;
    if (query || address) return { query: query || `Analyze ${address}`, address, chainId };
  }
  // Plain string -- check for embedded address
  const plain = typeof parsed === 'string' ? parsed : raw;
  const match = ETH_ADDRESS_RE.exec(plain);
  return { query: plain, address: match ? match[0] : undefined };
}

// â”€â”€ Pipelines â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runResearchPipeline(task: ResearchTask): Promise<SynthesisResult> {
  console.log(`[coordinator] research pipeline: "${task.query}"`);

  const wr = await webResearch(task.query, task.maxSources ?? 6);
  console.log(`[coordinator] web research: ${wr.findings.length} findings`);

  const verification = await verifySources(wr.findings.map((f) => f.url));
  const accessible = verification.results.filter((r) => r.isAccessible).length;
  console.log(`[coordinator] source verification: ${accessible}/${wr.findings.length} accessible`);

  const result = await synthesize({ task, webResearch: wr, verification });
  console.log(`[coordinator] synthesis complete: confidence=${result.confidenceScore}/100`);

  return result;
}

async function runRiskPipeline(task: RiskAnalysisTask): Promise<RiskAnalysisResult> {
  console.log(`[coordinator] risk pipeline: ${task.address} (chainId: ${task.chainId ?? 1})`);
  const result = await analyzeRisk(task);
  console.log(`[coordinator] risk analysis: ${result.badge} (score: ${result.riskScore}/100)`);
  return result;
}

async function runDueDiligencePipeline(requirements: string): Promise<DueDiligenceResult> {
  const req = parseDueDiligenceRequest(requirements);
  console.log(`[coordinator] due diligence pipeline: query="${req.query}" address=${req.address ?? 'none'}`);

  // Run research and risk in parallel when both are present
  const [research, risk] = await Promise.all([
    runResearchPipeline({ query: req.query }),
    req.address ? runRiskPipeline({ address: req.address, chainId: req.chainId }) : Promise.resolve(null),
  ]);

  const riskSection = risk
    ? `## Risk Analysis\n\n**Address:** \`${risk.address}\`  \n**Badge:** ${risk.badge} | **Score:** ${risk.riskScore}/100\n\n**Risk Factors:**\n${risk.reasons.map((r) => `- ${r}`).join('\n')}\n\n${risk.report}`
    : '## Risk Analysis\n\nNo contract address provided â€” risk analysis skipped.';

  const overallConfidence = risk
    ? Math.round((research.confidenceScore + (100 - risk.riskScore)) / 2)
    : research.confidenceScore;

  const combinedReport = [
    `# Due Diligence Report`,
    ``,
    `**Query:** ${req.query}`,
    req.address ? `**Contract:** \`${req.address}\`` : '',
    `**Overall Confidence:** ${overallConfidence}/100`,
    ``,
    `---`,
    ``,
    `## Research Findings`,
    ``,
    research.report,
    ``,
    `---`,
    ``,
    riskSection,
    ``,
    `---`,
    ``,
    `## Combined Assessment`,
    ``,
    `**Research confidence:** ${research.confidenceScore}/100 (${research.verifiedSources.length} verified sources)`,
    risk ? `**Risk score:** ${risk.riskScore}/100 â€” ${risk.badge}` : '',
    ``,
    `### Key Research Findings`,
    research.keyFindings.map((f) => `- ${f}`).join('\n'),
    risk && risk.reasons.length > 0 ? `\n### Risk Factors\n${risk.reasons.map((r) => `- ${r}`).join('\n')}` : '',
    ``,
    `### Recommendations`,
    research.recommendations.map((r) => `- ${r}`).join('\n'),
  ].filter((l) => l !== undefined).join('\n');

  console.log(`[coordinator] due diligence complete: overall confidence=${overallConfidence}/100`);

  return {
    type: 'due_diligence',
    query: req.query,
    address: req.address ?? null,
    research,
    risk,
    combinedReport,
    analyzedAt: new Date().toISOString(),
  };
}

// ── Stage 5: Hyperliquid Vault Analysis ──────────────────────────────────────

interface HyperliquidVaultDetails {
  name: string;
  leader: string;
  tvl: string;
  maxFollowers: number;
  numFollowers: number;
  apr: number;
  commission: number;
  isClosed: boolean;
}

async function runHyperliquidPipeline(task: HyperliquidVaultTask): Promise<HyperliquidVaultResult> {
  console.log(`[coordinator] hyperliquid pipeline: ${task.vaultAddress}`);

  const res = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'vaultDetails', vaultAddress: task.vaultAddress }),
  });
  if (!res.ok) throw new Error(`Hyperliquid API error: ${res.status}`);
  const vaultPayload = await res.json();
  if (!vaultPayload || typeof vaultPayload !== 'object') {
    throw new Error(`Hyperliquid API returned invalid vault data for ${task.vaultAddress}`);
  }
  const vault = vaultPayload as HyperliquidVaultDetails;
  if (vault.tvl == null || vault.name == null || vault.leader == null) {
    throw new Error(`Hyperliquid vault not found or invalid for ${task.vaultAddress}`);
  }

  const tvl = parseFloat(vault.tvl ?? '0');
  const apr = vault.apr ?? 0;
  const commission = vault.commission ?? 0;
  const followers = vault.numFollowers ?? 0;
  const maxFollowers = vault.maxFollowers ?? 0;
  const capacity = maxFollowers > 0 ? Math.round((followers / maxFollowers) * 100) : 0;

  const userPrompt = `Hyperliquid Vault Data:
Name: ${vault.name}
Address: ${task.vaultAddress}
Leader: ${vault.leader}
TVL: $${tvl.toLocaleString()}
APR: ${apr}%
Commission: ${commission}%
Followers: ${followers} / ${maxFollowers} (${capacity}% capacity)
Closed to new followers: ${vault.isClosed ? 'Yes' : 'No'}

Analyze this Hyperliquid vault and produce a calibrated risk assessment. Consider:
- High APR (>200%) may indicate unsustainable strategies or high leverage risk
- Low TVL (<$10K) increases manipulation risk
- High commission (>20%) reduces net returns significantly
- Near-full capacity limits entry and may reduce liquidity
- Closed vaults block new followers entirely

Return a JSON object with exactly these fields:
{
  "badge": "SAFE" | "CAUTION" | "DANGEROUS",
  "riskScore": <integer 0-100>,
  "vaultOverview": "<2-3 sentence summary of what this vault is and how it operates>",
  "performanceAnalysis": "<paragraph on APR, TVL trends, and return sustainability>",
  "riskFactors": ["<specific risk 1>", ...],
  "recommendation": "<clear actionable recommendation for a DeFi investor>",
  "report": "<full markdown report with ## Vault Overview, ## Performance Analysis, ## Risk Assessment, ## Recommendation sections>"
}

Scoring: 0-30 = SAFE, 31-65 = CAUTION, 66-100 = DANGEROUS. Badge must match score.
Return only valid JSON. No markdown fences.`;

  try {
    const text = await groqJson(
      'You are a DeFi analyst specializing in on-chain vault strategies and Hyperliquid perpetuals trading. Provide calibrated, accurate risk assessments.',
      userPrompt,
    );
    const parsed = JSON.parse(extractJson(text)) as {
      badge: 'SAFE' | 'CAUTION' | 'DANGEROUS';
      riskScore: number;
      vaultOverview: string;
      performanceAnalysis: string;
      riskFactors: string[];
      recommendation: string;
      report: string;
    };

    console.log(`[coordinator] hyperliquid: ${vault.name} -> ${parsed.badge} (score: ${parsed.riskScore}/100)`);

    return {
      vaultAddress: task.vaultAddress,
      name: vault.name,
      tvl,
      apr,
      leader: vault.leader,
      followers,
      maxFollowers,
      commission,
      badge: parsed.badge,
      riskScore: Math.max(0, Math.min(100, parsed.riskScore)),
      report: parsed.report,
      analyzedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error('[coordinator] hyperliquid analysis failed after retries:', err);
    return {
      vaultAddress: task.vaultAddress,
      name: vault.name,
      tvl,
      apr,
      leader: vault.leader,
      followers,
      maxFollowers,
      commission,
      badge: 'CAUTION' as const,
      riskScore: 50,
      report: '## Vault Analysis\n\nUnable to complete AI analysis. Raw vault data was fetched but synthesis failed.',
      analyzedAt: new Date().toISOString(),
    };
  }
}


interface OrderEntry {
  requirements: string;
  serviceId: string;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const STARTED_AT = new Date();
let wsConnected = false;

function buildServiceLabels(): Record<string, string> {
  const map: Record<string, string> = {};
  const pairs: [string, string][] = [
    ['CROO_SERVICE_ID_RESEARCH', 'Research Query'],
    ['CROO_SERVICE_ID_RISK_CHECK', 'Contract Risk Check'],
    ['CROO_SERVICE_ID_RISK', 'Risk Agent'],
    ['CROO_SERVICE_ID_DUE_DILIGENCE', 'Full Due Diligence'],
    ['CROO_SERVICE_ID_HYPERLIQUID', 'Hyperliquid Vault'],
  ];
  for (const [envKey, label] of pairs) {
    const id = process.env[envKey];
    if (id) map[id] = label;
  }
  return map;
}

async function main() {
  // Delay startup so any previous Railway instance has time to receive SIGTERM and close its WS connection
  await sleep(6000);

  const client = new AgentClient(CROO_CONFIG, requireEnv('CROO_SDK_KEY_COORDINATOR'));
  const stream = await client.connectWebSocket();
  wsConnected = true;
  console.log('[coordinator] online -- services: research | risk_check | due_diligence | hyperliquid_vault');

  // orderId -> { requirements, serviceId } -- populated at accept, consumed at OrderPaid
  const userOrders = new Map<string, OrderEntry>();

  // Recover any orders that were paid but not delivered before last restart
  try {
    const paid = await client.listOrders({ role: 'provider', status: 'paid' } as Parameters<typeof client.listOrders>[0]);
    const paidOrders = Array.isArray(paid) ? paid : (paid as { orders?: unknown[] }).orders ?? [];
    if (paidOrders.length > 0) {
      console.log(`[coordinator] recovering ${paidOrders.length} paid order(s) from before restart`);
      for (const o of paidOrders as Array<{ orderId: string; serviceId: string; negotiationId: string }>) {
        try {
          const neg = await client.getNegotiation(o.negotiationId);
          const requirements = (neg as { requirements: string }).requirements ?? '';
          console.log(`[coordinator] recovering order ${o.orderId} (service: ${o.serviceId})`);
          // Process in background -- don't await so we don't block WS handler setup
          void processOrder(client, o.orderId, o.serviceId, requirements);
        } catch (err) {
          console.error(`[coordinator] failed to recover order ${o.orderId}:`, err);
        }
      }
    }
  } catch (err) {
    console.error('[coordinator] startup recovery failed:', err);
  }

  // ── HTTP dashboard API ────────────────────────────────────────────────────────
  const API_PORT = parseInt(process.env['PORT'] ?? '8080');
  const DASHBOARD_SECRET = process.env['DASHBOARD_SECRET'] ?? '';
  const serviceLabels = buildServiceLabels();

  const httpServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (DASHBOARD_SECRET) {
      const auth = (req.headers['authorization'] ?? '').replace('Bearer ', '');
      if (auth !== DASHBOARD_SECRET) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    const pathname = new URL(req.url ?? '/', `http://localhost`).pathname;

    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: wsConnected ? 'online' : 'offline',
        uptimeSeconds: Math.floor((Date.now() - STARTED_AT.getTime()) / 1000),
        startedAt: STARTED_AT.toISOString(),
        activeOrders: userOrders.size,
        services: ['Research Query', 'Contract Risk Check', 'Full Due Diligence', 'Hyperliquid Vault'],
      }));
      return;
    }

    if (pathname === '/api/orders') {
      try {
        const raw = await client.listOrders({ role: 'provider' } as Parameters<typeof client.listOrders>[0]);
        const list: unknown[] = Array.isArray(raw) ? raw : ((raw as { orders?: unknown[] }).orders ?? []);
        const orders = list.map((o) => {
          const order = o as Record<string, unknown>;
          const svcId = typeof order['serviceId'] === 'string' ? order['serviceId'] : '';
          return { ...order, serviceName: serviceLabels[svcId] ?? svcId };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ orders }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    res.writeHead(404);
    res.end();
  });

  httpServer.listen(API_PORT, () => {
    console.log(`[coordinator] HTTP API on port ${API_PORT}`);
  });

  stream.on(EventType.NegotiationCreated, async (e) => {
    try {
      const result = await client.acceptNegotiation(e.negotiation_id!);
      userOrders.set(result.order.orderId, {
        requirements: result.negotiation.requirements,
        serviceId: result.negotiation.serviceId,
      });
      console.log(
        `[coordinator] accepted negotiation â†' order ${result.order.orderId} (service: ${result.negotiation.serviceId})`,
      );
    } catch (err) {
      console.error('[coordinator] failed to accept negotiation:', err);
    }
  });

  stream.on(EventType.OrderPaid, async (e) => {
    const orderId = e.order_id!;
    const entry = userOrders.get(orderId);
    if (!entry) return;
    userOrders.delete(orderId);
    console.log(`[coordinator] order paid: ${orderId} (service: ${entry.serviceId})`);
    void processOrder(client, orderId, entry.serviceId, entry.requirements);
  });

  function shutdown() {
    wsConnected = false;
    console.log('[coordinator] shutting down -- closing WebSocket');
    stream.close();
    httpServer.close();
    setTimeout(() => process.exit(0), 3000);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function processOrder(client: AgentClient, orderId: string, serviceId: string, requirements: string): Promise<void> {
  const RESEARCH_SVC = requireEnv('CROO_SERVICE_ID_RESEARCH');
  const RISK_SVC = requireEnv('CROO_SERVICE_ID_RISK_CHECK');
  const RISK_AGENT_SVC = requireEnv('CROO_SERVICE_ID_RISK');
  const DD_SVC = requireEnv('CROO_SERVICE_ID_DUE_DILIGENCE');
  const HL_SVC = requireEnv('CROO_SERVICE_ID_HYPERLIQUID');

  try {
    let result: SynthesisResult | RiskAnalysisResult | DueDiligenceResult | HyperliquidVaultResult;
    let pipelineLabel: string;

    if (serviceId === RESEARCH_SVC) {
      result = await runResearchPipeline(parseResearchRequest(requirements));
      pipelineLabel = 'research';
    } else if (serviceId === RISK_SVC || serviceId === RISK_AGENT_SVC) {
      result = await runRiskPipeline(parseRiskRequest(requirements));
      pipelineLabel = 'risk_check';
    } else if (serviceId === DD_SVC) {
      result = await runDueDiligencePipeline(unwrapText(requirements));
      pipelineLabel = 'due_diligence';
    } else if (serviceId === HL_SVC) {
      result = await runHyperliquidPipeline(parseHyperliquidRequest(requirements));
      pipelineLabel = 'hyperliquid_vault';
    } else {
      throw new Error(`Unknown service ID: ${serviceId}`);
    }

    await client.deliverOrder(orderId, {
      deliverableType: DeliverableType.Text,
      deliverableText: JSON.stringify(result),
    });
    console.log(`[coordinator] delivered ${pipelineLabel} result for order ${orderId}`);
  } catch (err) {
    console.error('[coordinator] pipeline failed:', err);
    const reason = err instanceof Error ? err.message : 'Pipeline failed';
    if (err instanceof APIError) {
      await client.rejectOrder(orderId, err.message).catch(() => {});
    } else {
      await client.rejectOrder(orderId, reason).catch(() => {});
    }
  }
}

main().catch((err) => {
  console.error('[coordinator] fatal:', err);
  process.exit(1);
});
