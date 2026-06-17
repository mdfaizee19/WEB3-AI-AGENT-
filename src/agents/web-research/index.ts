import 'dotenv/config';
import { AgentClient, EventType, DeliverableType, APIError } from '@croo-network/sdk';
import { CROO_CONFIG, requireEnv } from '../../config';
import type { ResearchTask, WebResearchResult, Finding } from '../../types';

interface SerperOrganicResult {
  title: string;
  link: string;
  snippet: string;
  source?: string;
}

interface SerperResponse {
  organic?: SerperOrganicResult[];
}

async function search(query: string, maxSources: number): Promise<Finding[]> {
  const apiKey = requireEnv('SERPER_API_KEY');
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey,
    },
    body: JSON.stringify({ q: query, num: maxSources }),
  });

  if (!res.ok) throw new Error(`Serper API error: ${res.status}`);

  const data = (await res.json()) as SerperResponse;
  return (data.organic ?? []).slice(0, maxSources).map((item) => ({
    title: item.title,
    url: item.link,
    snippet: item.snippet,
    source: item.source ?? new URL(item.link).hostname,
  }));
}

async function main() {
  const sdkKey = requireEnv('CROO_SDK_KEY_WEB_RESEARCH');
  const client = new AgentClient(CROO_CONFIG, sdkKey);
  const stream = await client.connectWebSocket();

  console.log('[web-research] agent online');

  stream.on(EventType.NegotiationCreated, async (e) => {
    try {
      const result = await client.acceptNegotiation(e.negotiation_id!);
      console.log(`[web-research] accepted negotiation → order ${result.order.orderId}`);
    } catch (err) {
      console.error('[web-research] failed to accept negotiation:', err);
    }
  });

  stream.on(EventType.OrderPaid, async (e) => {
    const orderId = e.order_id!;
    console.log(`[web-research] order paid: ${orderId}`);

    try {
      const order = await client.getOrder(orderId);
      const neg = await client.getNegotiation(order.negotiationId);

      let task: ResearchTask;
      try {
        const parsed = JSON.parse(neg.requirements) as unknown;
        task = typeof parsed === 'string'
          ? { query: parsed }
          : (parsed as ResearchTask);
      } catch {
        task = { query: neg.requirements };
      }

      const findings = await search(task.query, task.maxSources ?? 6);

      const result: WebResearchResult = {
        query: task.query,
        findings,
        searchedAt: new Date().toISOString(),
      };

      await client.deliverOrder(orderId, {
        deliverableType: DeliverableType.Text,
        deliverableText: JSON.stringify(result),
      });

      console.log(`[web-research] delivered ${findings.length} findings for "${task.query}"`);
    } catch (err) {
      console.error('[web-research] processing error:', err);
      if (err instanceof APIError) {
        await client.rejectOrder(orderId, err.message).catch(() => {});
      } else {
        await client.rejectOrder(orderId, 'Internal search error').catch(() => {});
      }
    }
  });

  process.on('SIGINT', () => {
    stream.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[web-research] fatal:', err);
  process.exit(1);
});
