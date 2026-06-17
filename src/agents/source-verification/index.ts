import 'dotenv/config';
import { AgentClient, EventType, DeliverableType, APIError } from '@croo-network/sdk';
import { CROO_CONFIG, requireEnv } from '../../config';
import type {
  SourceVerificationInput,
  SourceVerificationResult,
  VerificationResult,
} from '../../types';

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
    return {
      url,
      isAccessible: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function verifyAll(urls: string[]): Promise<VerificationResult[]> {
  return Promise.all(urls.map(verifyUrl));
}

async function main() {
  const sdkKey = requireEnv('CROO_SDK_KEY_SOURCE_VERIFICATION');
  const client = new AgentClient(CROO_CONFIG, sdkKey);
  const stream = await client.connectWebSocket();

  console.log('[source-verification] agent online');

  stream.on(EventType.NegotiationCreated, async (e) => {
    try {
      const result = await client.acceptNegotiation(e.negotiation_id!);
      console.log(`[source-verification] accepted negotiation → order ${result.order.orderId}`);
    } catch (err) {
      console.error('[source-verification] failed to accept negotiation:', err);
    }
  });

  stream.on(EventType.OrderPaid, async (e) => {
    const orderId = e.order_id!;
    console.log(`[source-verification] order paid: ${orderId}`);

    try {
      const order = await client.getOrder(orderId);
      const neg = await client.getNegotiation(order.negotiationId);

      let input: SourceVerificationInput;
      try {
        input = JSON.parse(neg.requirements) as SourceVerificationInput;
      } catch {
        throw new Error('Invalid requirements: expected JSON with urls array');
      }

      if (!Array.isArray(input.urls) || input.urls.length === 0) {
        throw new Error('No URLs provided for verification');
      }

      console.log(`[source-verification] verifying ${input.urls.length} URLs`);
      const results = await verifyAll(input.urls);

      const accessible = results.filter((r) => r.isAccessible).length;
      console.log(`[source-verification] ${accessible}/${results.length} URLs accessible`);

      const payload: SourceVerificationResult = {
        results,
        verifiedAt: new Date().toISOString(),
      };

      await client.deliverOrder(orderId, {
        deliverableType: DeliverableType.Text,
        deliverableText: JSON.stringify(payload),
      });
    } catch (err) {
      console.error('[source-verification] processing error:', err);
      if (err instanceof APIError) {
        await client.rejectOrder(orderId, err.message).catch(() => {});
      } else {
        await client.rejectOrder(orderId, 'Internal verification error').catch(() => {});
      }
    }
  });

  process.on('SIGINT', () => {
    stream.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[source-verification] fatal:', err);
  process.exit(1);
});
