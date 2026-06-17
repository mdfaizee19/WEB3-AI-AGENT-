import 'dotenv/config';
import { AgentClient, EventType, DeliverableType, APIError } from '@croo-network/sdk';
import { CROO_CONFIG, requireEnv } from '../../config';
import type { RiskAnalysisTask, RiskAnalysisResult } from '../../types';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

interface EtherscanResponse<T> {
  status: string;
  message: string;
  result: T;
}

interface EthTx {
  from: string;
  to: string;
  value: string;
  isError: string;
  functionName: string;
}

interface TokenTx {
  tokenSymbol: string;
  tokenName: string;
  contractAddress: string;
}

interface ContractSource {
  ContractName: string;
  CompilerVersion: string;
  SourceCode: string;
  Proxy: string;
  Implementation: string;
}

function explorerApiUrl(chainId: number): string {
  if (chainId === 8453) return 'https://api.basescan.org/api';
  if (chainId === 137) return 'https://api.polygonscan.com/api';
  return 'https://api.etherscan.io/api';
}

async function fetchEtherscan<T>(params: Record<string, string>, chainId = 1): Promise<T | null> {
  const url = new URL(explorerApiUrl(chainId));
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

function extractJson(text: string): string {
  const stripped = text.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  return start !== -1 && end > start ? stripped.slice(start, end + 1) : stripped;
}

async function gatherAddressContext(address: string, chainId: number): Promise<string> {
  const [balance, txList, tokenTxs, sourceCode] = await Promise.allSettled([
    fetchEtherscan<string>({ module: 'account', action: 'balance', address, tag: 'latest' }, chainId),
    fetchEtherscan<EthTx[]>({
      module: 'account', action: 'txlist', address,
      sort: 'desc', page: '1', offset: '25',
    }, chainId),
    fetchEtherscan<TokenTx[]>({
      module: 'account', action: 'tokentx', address,
      sort: 'desc', page: '1', offset: '25',
    }, chainId),
    fetchEtherscan<ContractSource[]>({ module: 'contract', action: 'getsourcecode', address }, chainId),
  ]);

  const chainName = chainId === 8453 ? 'Base' : chainId === 137 ? 'Polygon' : 'Ethereum';
  const lines: string[] = [`Address: ${address}`, `Chain: ${chainName} (chainId: ${chainId})`, ''];

  if (balance.status === 'fulfilled' && balance.value !== null) {
    const eth = Number(BigInt(balance.value)) / 1e18;
    lines.push(`Native Balance: ${eth.toFixed(6)} ETH`);
  }

  const src = sourceCode.status === 'fulfilled' ? sourceCode.value?.[0] : null;
  if (src?.ContractName) {
    lines.push(`Type: Contract — ${src.ContractName}`);
    lines.push(`Compiler: ${src.CompilerVersion}`);
    lines.push(`Source verified: ${src.SourceCode ? 'Yes' : 'No'}`);
    if (src.Proxy === '1') lines.push(`Proxy: Yes (implementation: ${src.Implementation})`);
  } else {
    lines.push('Type: EOA (externally owned account)');
  }

  if (txList.status === 'fulfilled' && Array.isArray(txList.value)) {
    const txs = txList.value;
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
  }

  if (tokenTxs.status === 'fulfilled' && Array.isArray(tokenTxs.value)) {
    const tokens = tokenTxs.value;
    const unique = [...new Map(tokens.map((t) => [t.contractAddress, t])).values()];
    lines.push(`\nToken interactions (${unique.length} unique):`);
    for (const t of unique.slice(0, 10)) {
      lines.push(`  ${t.tokenSymbol} (${t.tokenName}) — ${t.contractAddress}`);
    }
  }

  return lines.join('\n');
}

async function analyzeRisk(task: RiskAnalysisTask): Promise<RiskAnalysisResult> {
  const chainId = task.chainId ?? 1;
  console.log(`[risk] gathering on-chain data for ${task.address} (chainId: ${chainId})`);
  const context = await gatherAddressContext(task.address, chainId);

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

  const apiKey = requireEnv('GROQ_API_KEY');
  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        {
          role: 'system',
          content: 'You are a blockchain security expert specializing in Ethereum and EVM chain risk analysis.',
        },
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
  const sdkKey = requireEnv('CROO_SDK_KEY_RISK');
  const client = new AgentClient(CROO_CONFIG, sdkKey);
  const stream = await client.connectWebSocket();

  console.log('[risk] agent online');

  stream.on(EventType.NegotiationCreated, async (e) => {
    try {
      const result = await client.acceptNegotiation(e.negotiation_id!);
      console.log(`[risk] accepted negotiation → order ${result.order.orderId}`);
    } catch (err) {
      console.error('[risk] failed to accept negotiation:', err);
    }
  });

  stream.on(EventType.OrderPaid, async (e) => {
    const orderId = e.order_id!;
    console.log(`[risk] order paid: ${orderId}`);

    try {
      const order = await client.getOrder(orderId);
      const neg = await client.getNegotiation(order.negotiationId);

      let task: RiskAnalysisTask;
      try {
        const parsed = JSON.parse(neg.requirements) as unknown;
        task = typeof parsed === 'string'
          ? { address: parsed }
          : (parsed as RiskAnalysisTask);
      } catch {
        task = { address: neg.requirements.trim() };
      }

      if (!/^0x[0-9a-fA-F]{40}$/.test(task.address)) {
        throw new Error(`Invalid Ethereum address: ${task.address}`);
      }

      const result = await analyzeRisk(task);
      console.log(`[risk] ${task.address} → ${result.badge} (score: ${result.riskScore}/100)`);

      await client.deliverOrder(orderId, {
        deliverableType: DeliverableType.Text,
        deliverableText: JSON.stringify(result),
      });
    } catch (err) {
      console.error('[risk] processing error:', err);
      if (err instanceof APIError) {
        await client.rejectOrder(orderId, err.message).catch(() => {});
      } else {
        const msg = err instanceof Error ? err.message : 'Internal risk analysis error';
        await client.rejectOrder(orderId, msg).catch(() => {});
      }
    }
  });

  process.on('SIGINT', () => {
    stream.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[risk] fatal:', err);
  process.exit(1);
});
