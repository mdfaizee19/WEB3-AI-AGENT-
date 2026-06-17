import 'dotenv/config';
import { AgentClient, EventType, DeliverableType, APIError } from '@croo-network/sdk';
import { CROO_CONFIG, requireEnv } from '../../config';
import type { SynthesisInput, SynthesisResult } from '../../types';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

function extractJson(text: string): string {
  const stripped = text.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  return start !== -1 && end > start ? stripped.slice(start, end + 1) : stripped;
}

async function synthesize(input: SynthesisInput): Promise<SynthesisResult> {
  const { task, webResearch, verification } = input;

  const verifiedUrls = new Set(
    verification.results.filter((r) => r.isAccessible).map((r) => r.url),
  );

  const verifiedFindings = webResearch.findings.filter((f) => verifiedUrls.has(f.url));
  const unverifiedFindings = webResearch.findings.filter((f) => !verifiedUrls.has(f.url));
  const orderedFindings = [...verifiedFindings, ...unverifiedFindings];

  const findingsText = orderedFindings
    .map((f, i) => {
      const status = verifiedUrls.has(f.url) ? '✓ verified' : '⚠ unverified';
      return `[${i + 1}] ${f.title} (${status})\nSource: ${f.url}\n${f.snippet}`;
    })
    .join('\n\n');

  const prompt = `Query: "${task.query}"

Research findings (${verifiedFindings.length} verified, ${unverifiedFindings.length} unverified):

${findingsText || 'No findings available.'}

Produce a structured intelligence report as a JSON object with exactly these fields:
{
  "executiveSummary": "<2-3 sentence high-level overview>",
  "keyFindings": ["<key insight 1>", "<key insight 2>", ...],
  "riskAssessment": "<paragraph covering risks, red flags, and security considerations>",
  "recommendations": ["<actionable recommendation 1>", ...],
  "confidenceScore": <integer 0-100 based on source quality: ${verifiedFindings.length} of ${orderedFindings.length} sources verified>,
  "report": "<full markdown report with ## Executive Summary, ## Key Findings, ## Risk Assessment, ## Recommendations sections>"
}

Return only valid JSON. No markdown fences around the JSON itself.`;

  try {
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
            content: 'You are a Web3 Intelligence analyst specializing in DeFi research and smart contract analysis.',
          },
          { role: 'user', content: prompt },
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
    console.error('[synthesis] groq call failed, falling back to deterministic:', err);
    const parts = orderedFindings.slice(0, 3).map((f) => f.snippet).filter(Boolean);
    const executiveSummary = parts.join(' ').trim() || `No findings for: ${task.query}`;
    const keyFindings = orderedFindings
      .slice(0, 5)
      .map((f) => `[${f.source}] ${f.snippet || f.title}`)
      .filter(Boolean);

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

async function main() {
  const sdkKey = requireEnv('CROO_SDK_KEY_SYNTHESIS');
  const client = new AgentClient(CROO_CONFIG, sdkKey);
  const stream = await client.connectWebSocket();

  console.log('[synthesis] agent online');

  stream.on(EventType.NegotiationCreated, async (e) => {
    try {
      const result = await client.acceptNegotiation(e.negotiation_id!);
      console.log(`[synthesis] accepted negotiation → order ${result.order.orderId}`);
    } catch (err) {
      console.error('[synthesis] failed to accept negotiation:', err);
    }
  });

  stream.on(EventType.OrderPaid, async (e) => {
    const orderId = e.order_id!;
    console.log(`[synthesis] order paid: ${orderId}`);

    try {
      const order = await client.getOrder(orderId);
      const neg = await client.getNegotiation(order.negotiationId);

      let input: SynthesisInput;
      try {
        input = JSON.parse(neg.requirements) as SynthesisInput;
      } catch {
        throw new Error('Invalid requirements: expected JSON with task, webResearch, verification');
      }

      const result = await synthesize(input);
      console.log(`[synthesis] confidence=${result.confidenceScore}/100, sources=${result.verifiedSources.length} verified`);

      await client.deliverOrder(orderId, {
        deliverableType: DeliverableType.Text,
        deliverableText: JSON.stringify(result),
      });
    } catch (err) {
      console.error('[synthesis] processing error:', err);
      if (err instanceof APIError) {
        await client.rejectOrder(orderId, err.message).catch(() => {});
      } else {
        await client.rejectOrder(orderId, 'Internal synthesis error').catch(() => {});
      }
    }
  });

  process.on('SIGINT', () => {
    stream.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[synthesis] fatal:', err);
  process.exit(1);
});
