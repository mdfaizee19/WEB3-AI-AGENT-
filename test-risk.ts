/**
 * test-risk.ts — standalone risk agent test (no CROO network)
 * Run: npx ts-node --transpile-only test-risk.ts [address] [chainId]
 */
import 'dotenv/config';
import type { RiskAnalysisTask, RiskAnalysisResult } from './src/types';

const ADDRESS = process.argv[2] ?? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CHAIN_ID = Number(process.argv[3] ?? '8453'); // Base mainnet

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

const hr = (label = '') =>
  console.log(`\n${'─'.repeat(64)}${label ? `\n${label}` : ''}`);

interface EtherscanResponse<T> { status: string; message: string; result: T }
interface EthTx { from: string; to: string; value: string; isError: string; functionName: string }
interface TokenTx { tokenSymbol: string; tokenName: string; contractAddress: string }
interface ContractSource { ContractName: string; CompilerVersion: string; SourceCode: string; Proxy: string; Implementation: string }

function explorerApiUrl(chainId: number): string {
  if (chainId === 8453) return 'https://api.basescan.org/api';
  if (chainId === 137) return 'https://api.polygonscan.com/api';
  return 'https://api.etherscan.io/api';
}

async function fetchExplorer<T>(params: Record<string, string>, chainId: number): Promise<T | null> {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) throw new Error('ETHERSCAN_API_KEY not set');
  const url = new URL(explorerApiUrl(chainId));
  url.searchParams.set('apikey', apiKey);
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

function extractJson(text: string): string {
  const stripped = text.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  return start !== -1 && end > start ? stripped.slice(start, end + 1) : stripped;
}

async function gatherAndPrint(address: string, chainId: number): Promise<string> {
  const chainName = chainId === 8453 ? 'Base' : chainId === 137 ? 'Polygon' : 'Ethereum';
  console.log(`\nFetching on-chain data from ${chainName} explorer…`);

  const [balance, txList, tokenTxs, sourceCode] = await Promise.allSettled([
    fetchExplorer<string>({ module: 'account', action: 'balance', address, tag: 'latest' }, chainId),
    fetchExplorer<EthTx[]>({ module: 'account', action: 'txlist', address, sort: 'desc', page: '1', offset: '25' }, chainId),
    fetchExplorer<TokenTx[]>({ module: 'account', action: 'tokentx', address, sort: 'desc', page: '1', offset: '25' }, chainId),
    fetchExplorer<ContractSource[]>({ module: 'contract', action: 'getsourcecode', address }, chainId),
  ]);

  const lines: string[] = [`Address: ${address}`, `Chain: ${chainName} (chainId: ${chainId})`, ''];

  if (balance.status === 'fulfilled' && balance.value !== null) {
    const eth = Number(BigInt(balance.value as string)) / 1e18;
    lines.push(`Native Balance: ${eth.toFixed(6)} ETH`);
  } else {
    lines.push('Native Balance: unavailable');
  }

  const src = sourceCode.status === 'fulfilled' ? sourceCode.value?.[0] : null;
  if (src?.ContractName) {
    lines.push(`Type: Contract — ${src.ContractName}`);
    lines.push(`Compiler: ${src.CompilerVersion}`);
    lines.push(`Source verified: ${src.SourceCode ? 'Yes' : 'No'}`);
    if (src.Proxy === '1') lines.push(`Proxy: Yes (implementation: ${src.Implementation})`);
  } else {
    lines.push('Type: EOA or unverified contract');
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
      const status = tx.isError === '1' ? ' (FAILED)' : '';
      lines.push(`  ${dir} ${eth} ETH → ${tx.to}${fn}${status}`);
    }
  } else {
    lines.push('\nTransaction history: unavailable');
  }

  if (tokenTxs.status === 'fulfilled' && Array.isArray(tokenTxs.value)) {
    const tokens = tokenTxs.value as TokenTx[];
    const unique = [...new Map(tokens.map((t) => [t.contractAddress, t])).values()];
    lines.push(`\nToken interactions (${unique.length} unique):`);
    for (const t of unique.slice(0, 10)) {
      lines.push(`  ${t.tokenSymbol} (${t.tokenName}) — ${t.contractAddress}`);
    }
  }

  const context = lines.join('\n');
  console.log('\n' + context);
  return context;
}

async function analyzeRisk(task: RiskAnalysisTask): Promise<RiskAnalysisResult> {
  const chainId = task.chainId ?? 1;
  const context = await gatherAndPrint(task.address, chainId);

  const prompt = `On-chain data:
${context}

Analyze this address for risk factors:
- EOA risks: phishing/drainer patterns, mixer/tumbler usage, suspicious high-value outflows, interaction with flagged contracts
- Contract risks: unverified source code, centralized ownership, proxy upgrade risks, honeypot patterns, rug pull indicators (mint functions, blacklist functions, max tx limits)
- General: high transaction failure rate, interaction with known scam tokens, anomalous patterns

Return a JSON object with exactly these fields:
{
  "badge": "SAFE" | "CAUTION" | "DANGEROUS",
  "riskScore": <integer 0-100>,
  "reasons": ["<specific risk factor 1>", "<specific risk factor 2>", ...],
  "report": "<markdown risk report with ## Risk Summary, ## On-Chain Analysis, ## Risk Factors, ## Recommendations sections>"
}

Scoring guide: 0-30 → SAFE, 31-65 → CAUTION, 66-100 → DANGEROUS. Badge must match riskScore range.
Return only valid JSON. No markdown fences.`;

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: 'You are a blockchain security expert specializing in EVM chain risk analysis.' },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Groq API error: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  const text = data.choices[0]?.message?.content ?? '';
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
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║   ATTESTR RISK AGENT TEST (no CROO network)                    ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');

  const task: RiskAnalysisTask = { address: ADDRESS, chainId: CHAIN_ID };
  console.log(`\nAnalyzing: ${task.address}  (chainId: ${task.chainId})`);

  hr('ON-CHAIN DATA (Basescan/Etherscan)');
  console.log('Calling Groq for risk analysis…');
  const result = await analyzeRisk(task);

  hr('RISK ANALYSIS RESULT');
  console.log(`Badge      : ${result.badge}`);
  console.log(`Risk Score : ${result.riskScore}/100`);
  console.log(`\nRisk Reasons (${result.reasons.length}):`);
  result.reasons.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));

  hr('FULL RISK REPORT (markdown)');
  console.log(result.report);

  hr('RISK TEST COMPLETE ✅');
}

main().catch((err) => {
  console.error('\n❌ Risk test failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
