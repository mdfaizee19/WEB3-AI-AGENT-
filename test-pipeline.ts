/**
 * test-pipeline.ts — runs the full Attestr research pipeline WITHOUT the CAP /
 * CROO network layer. It exercises the exact logic each agent runs internally:
 *
 *   1. Web Research        — Serper API (Google Search)
 *   2. Source Verification — HTTP HEAD checks on every URL
 *   3. Synthesis           — Groq (llama-3.3-70b-versatile) intelligence report
 *
 * Run:  npx ts-node --transpile-only test-pipeline.ts
 */
import 'dotenv/config';
import type {
  Finding,
  WebResearchResult,
  VerificationResult,
  SourceVerificationResult,
  SynthesisInput,
  SynthesisResult,
} from './src/types';

const TEST_QUERY = process.argv[2] ?? 'What are the risks of using Uniswap V4 in 2026?';

const hr = (label = '') =>
  console.log(`\n${'─'.repeat(64)}${label ? `\n${label}` : ''}`);

// ── Stage 1: Web Research (Serper API — Google Search) ────────────────────────

interface SerperOrganicResult { title: string; link: string; snippet: string; source?: string }
interface SerperResponse { organic?: SerperOrganicResult[] }

async function webResearch(query: string, maxSources = 6): Promise<WebResearchResult> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) throw new Error('SERPER_API_KEY not set');

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

// ── Stage 2: Source Verification (HTTP HEAD) ───────────────────────────────────

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

// ── Stage 3: Synthesis (Gemini gemini-2.0-flash) ───────────────────────────────

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

function extractJson(text: string): string {
  const stripped = text.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  return start !== -1 && end > start ? stripped.slice(start, end + 1) : stripped;
}

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
      const status = verifiedUrls.has(f.url) ? '✓ verified' : '⚠ unverified';
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
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error('GROQ_API_KEY not set');

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
            content: 'You are a Web3 Intelligence analyst specializing in DeFi research and smart contract analysis.',
          },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (!res.ok) throw new Error(`Groq API error: ${res.status} ${await res.text()}`);

    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    const text = data.choices[0]?.message?.content ?? '';
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
      confidenceScore: Math.max(0, Math.min(100, parsed.confidenceScore)),
      verifiedSources: [...verifiedUrls],
      unverifiedSources: unverifiedFindings.map((f) => f.url),
      report: parsed.report,
      synthesizedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.warn(`[synthesis] Groq unavailable (${err instanceof Error ? err.message.split('\n')[0] : err}), using deterministic fallback`);
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
      report: `## ${task.query}\n\n${executiveSummary}\n\n### Key Findings\n${keyFindings.map((f, i) => `${i + 1}. ${f}`).join('\n')}`,
      synthesizedAt: new Date().toISOString(),
    };
  }
}

// ── Orchestration ──────────────────────────────────────────────────────────────

async function main() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║   ATTESTR PIPELINE TEST (no CAP / no CROO network)              ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log(`\nQuery: "${TEST_QUERY}"`);

  // Step 1
  hr('STEP 1 — Web Research Agent (Serper / Google Search)');
  const wr = await webResearch(TEST_QUERY);
  console.log(`Found ${wr.findings.length} findings:`);
  wr.findings.forEach((f, i) =>
    console.log(`  [${i + 1}] ${f.title}\n      ${f.url}\n      "${f.snippet.slice(0, 120)}${f.snippet.length > 120 ? '…' : ''}"`),
  );

  // Step 2
  hr('STEP 2 — Source Verification Agent (HTTP HEAD)');
  const urls = wr.findings.map((f) => f.url);
  const verification = await verifySources(urls);
  const accessible = verification.results.filter((r) => r.isAccessible).length;
  console.log(`Checked ${urls.length} URLs — ${accessible} accessible, ${urls.length - accessible} not:`);
  verification.results.forEach((r) =>
    console.log(`  ${r.isAccessible ? '✓' : '✗'} [${r.statusCode ?? r.error ?? 'n/a'}] ${r.url}`),
  );

  // Step 3
  hr('STEP 3 — Synthesis Agent (Groq llama-3.3-70b-versatile)');
  console.log('Calling Groq (llama-3.3-70b-versatile)…');
  const synthesis = await synthesize({
    task: { query: TEST_QUERY },
    webResearch: wr,
    verification,
  });

  console.log('✅ Groq responded\n');
  console.log(`Confidence Score : ${synthesis.confidenceScore}/100`);
  console.log(`Verified Sources : ${synthesis.verifiedSources.length}`);
  console.log(`Unverified       : ${synthesis.unverifiedSources.length}`);

  console.log('\n─── Executive Summary ───');
  console.log(synthesis.executiveSummary);

  console.log(`\n─── Key Findings (${synthesis.keyFindings.length}) ───`);
  synthesis.keyFindings.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));

  console.log('\n─── Risk Assessment ───');
  console.log(synthesis.riskAssessment);

  console.log(`\n─── Recommendations (${synthesis.recommendations.length}) ───`);
  synthesis.recommendations.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));

  hr('FINAL GEMINI-GENERATED SYNTHESIS REPORT (markdown)');
  console.log(synthesis.report);

  hr('PIPELINE COMPLETE ✅');
}

main().catch((err) => {
  console.error('\n❌ Pipeline failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
