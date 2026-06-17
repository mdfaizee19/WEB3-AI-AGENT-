import 'dotenv/config';
import {
  AgentClient,
  EventType,
  DeliverableType,
  APIError,
  type Event,
  type EventStream,
} from '@croo-network/sdk';
import { CROO_CONFIG, requireEnv } from '../config';
import type {
  ResearchTask,
  WebResearchResult,
  SourceVerificationInput,
  SourceVerificationResult,
  SynthesisInput,
  SynthesisResult,
} from '../types';

const SUB_AGENT_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingNegotiation {
  resolve: (orderId: string) => void;
  reject: (err: Error) => void;
}

interface PendingOrder {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
}

class Coordinator {
  private client: AgentClient;
  private stream!: EventStream;

  // Track our outbound sub-agent calls (requester role)
  private pendingNegotiations = new Map<string, PendingNegotiation>();
  private pendingOrders = new Map<string, PendingOrder>();

  // Track inbound user orders (provider role): orderId -> requirements string
  private userOrders = new Map<string, string>();

  constructor(sdkKey: string) {
    this.client = new AgentClient(CROO_CONFIG, sdkKey);
  }

  async start() {
    this.stream = await this.client.connectWebSocket();
    console.log('[coordinator] online');

    // Provider role: user is negotiating with us
    this.stream.on(EventType.NegotiationCreated, this.onNegotiationCreated.bind(this));

    // Requester role: sub-agent accepted our negotiation → pay
    // Provider role: our accepted negotiation created an order → ignore (wait for OrderPaid)
    this.stream.on(EventType.OrderCreated, this.onOrderCreated.bind(this));

    // Provider role: user paid → run pipeline
    this.stream.on(EventType.OrderPaid, this.onOrderPaid.bind(this));

    // Requester role: sub-agent delivered → resolve promise
    this.stream.on(EventType.OrderCompleted, this.onOrderCompleted.bind(this));

    // Requester role: sub-agent rejected/expired → reject promise
    this.stream.on(EventType.OrderRejected, this.onOrderFailed.bind(this));
    this.stream.on(EventType.OrderExpired, this.onOrderFailed.bind(this));

    // Negotiation rejected by sub-agent → reject promise
    this.stream.on(EventType.NegotiationRejected, this.onNegotiationRejected.bind(this));

    process.on('SIGINT', () => {
      this.stream.close();
      process.exit(0);
    });
  }

  // ── Provider handlers ────────────────────────────────────────────────────────

  private async onNegotiationCreated(e: Event) {
    const negId = e.negotiation_id!;
    try {
      const result = await this.client.acceptNegotiation(negId);
      const orderId = result.order.orderId;
      this.userOrders.set(orderId, result.negotiation.requirements);
      console.log(`[coordinator] accepted user negotiation → order ${orderId}`);
    } catch (err) {
      console.error('[coordinator] failed to accept user negotiation:', err);
    }
  }

  private async onOrderPaid(e: Event) {
    const orderId = e.order_id!;

    // Only handle orders where we are the provider (user orders)
    const requirements = this.userOrders.get(orderId);
    if (!requirements) return;

    console.log(`[coordinator] user order paid: ${orderId}`);
    this.userOrders.delete(orderId);

    let task: ResearchTask;
    try {
      const parsed = JSON.parse(requirements) as unknown;
      task = typeof parsed === 'string' ? { query: parsed } : (parsed as ResearchTask);
    } catch {
      task = { query: requirements };
    }

    try {
      const result = await this.runPipeline(task);
      await this.client.deliverOrder(orderId, {
        deliverableType: DeliverableType.Text,
        deliverableText: JSON.stringify(result),
      });
      console.log(`[coordinator] delivered research result for "${task.query}"`);
    } catch (err) {
      console.error('[coordinator] pipeline failed:', err);
      const reason = err instanceof Error ? err.message : 'Research pipeline failed';
      await this.client.rejectOrder(orderId, reason).catch(() => {});
    }
  }

  // ── Requester handlers ───────────────────────────────────────────────────────

  private async onOrderCreated(e: Event) {
    const negId = e.negotiation_id!;
    const orderId = e.order_id!;

    // Only handle orders WE initiated as requester
    const pending = this.pendingNegotiations.get(negId);
    if (!pending) return;

    try {
      await this.client.payOrder(orderId);
      pending.resolve(orderId);
      this.pendingNegotiations.delete(negId);
      console.log(`[coordinator] paid sub-agent order ${orderId}`);
    } catch (err) {
      pending.reject(err instanceof Error ? err : new Error(String(err)));
      this.pendingNegotiations.delete(negId);
    }
  }

  private async onOrderCompleted(e: Event) {
    const orderId = e.order_id!;
    const pending = this.pendingOrders.get(orderId);
    if (!pending) return;

    try {
      const delivery = await this.client.getDelivery(orderId);
      pending.resolve(delivery.deliverableText);
      this.pendingOrders.delete(orderId);
    } catch (err) {
      pending.reject(err instanceof Error ? err : new Error(String(err)));
      this.pendingOrders.delete(orderId);
    }
  }

  private onOrderFailed(e: Event) {
    const orderId = e.order_id!;
    const pending = this.pendingOrders.get(orderId);
    if (!pending) return;

    const reason = e.reason ?? e.type;
    pending.reject(new Error(`Sub-agent order ${orderId} failed: ${reason}`));
    this.pendingOrders.delete(orderId);
  }

  private onNegotiationRejected(e: Event) {
    const negId = e.negotiation_id!;
    const pending = this.pendingNegotiations.get(negId);
    if (!pending) return;

    const reason = e.reason ?? 'Negotiation rejected';
    pending.reject(new Error(`Sub-agent negotiation ${negId} rejected: ${reason}`));
    this.pendingNegotiations.delete(negId);
  }

  // ── Sub-agent call helper ────────────────────────────────────────────────────

  private callSubAgent(serviceId: string, requirements: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.client
        .negotiateOrder({ serviceId, requirements })
        .then((neg) => {
          const negId = neg.negotiationId;
          console.log(`[coordinator] negotiating with service ${serviceId} (neg: ${negId})`);

          const negTimeout = setTimeout(() => {
            this.pendingNegotiations.delete(negId);
            reject(new Error(`Negotiation timed out: ${negId}`));
          }, SUB_AGENT_TIMEOUT_MS);

          this.pendingNegotiations.set(negId, {
            resolve: (orderId) => {
              clearTimeout(negTimeout);

              const orderTimeout = setTimeout(() => {
                this.pendingOrders.delete(orderId);
                reject(new Error(`Order delivery timed out: ${orderId}`));
              }, SUB_AGENT_TIMEOUT_MS);

              this.pendingOrders.set(orderId, {
                resolve: (text) => {
                  clearTimeout(orderTimeout);
                  resolve(text);
                },
                reject: (err) => {
                  clearTimeout(orderTimeout);
                  reject(err);
                },
              });
            },
            reject: (err) => {
              clearTimeout(negTimeout);
              reject(err);
            },
          });
        })
        .catch(reject);
    });
  }

  // ── Research pipeline ────────────────────────────────────────────────────────

  private async runPipeline(task: ResearchTask): Promise<SynthesisResult> {
    console.log(`[coordinator] pipeline start: "${task.query}"`);

    // Step 1: Web research
    const webResearchText = await this.callSubAgent(
      requireEnv('CROO_SERVICE_ID_WEB_RESEARCH'),
      JSON.stringify(task),
    );
    const webResearch = JSON.parse(webResearchText) as WebResearchResult;
    console.log(`[coordinator] web research: ${webResearch.findings.length} findings`);

    // Step 2: Source verification
    const urls = webResearch.findings.map((f) => f.url);
    const verificationInput: SourceVerificationInput = { urls };
    const verificationText = await this.callSubAgent(
      requireEnv('CROO_SERVICE_ID_SOURCE_VERIFICATION'),
      JSON.stringify(verificationInput),
    );
    const verification = JSON.parse(verificationText) as SourceVerificationResult;
    const accessible = verification.results.filter((r) => r.isAccessible).length;
    console.log(`[coordinator] source verification: ${accessible}/${urls.length} accessible`);

    // Step 3: Synthesis
    const synthesisInput: SynthesisInput = { task, webResearch, verification };
    const synthesisText = await this.callSubAgent(
      requireEnv('CROO_SERVICE_ID_SYNTHESIS'),
      JSON.stringify(synthesisInput),
    );
    const result = JSON.parse(synthesisText) as SynthesisResult;
    console.log(`[coordinator] synthesis complete: confidence=${result.confidenceScore}/100`);

    return result;
  }
}

async function main() {
  const sdkKey = requireEnv('CROO_SDK_KEY_COORDINATOR');
  const coordinator = new Coordinator(sdkKey);
  await coordinator.start();
}

main().catch((err) => {
  console.error('[coordinator] fatal:', err);
  process.exit(1);
});
