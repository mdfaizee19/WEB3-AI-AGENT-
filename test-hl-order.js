require('dotenv').config({ override: true });
const { AgentClient } = require('@croo-network/sdk');

const B='\x1b[1m',R='\x1b[0m',G='\x1b[32m',Y='\x1b[33m',C='\x1b[36m',RD='\x1b[31m',DIM='\x1b[2m';

const CROO_CONFIG = {
  baseURL: process.env.CROO_API_URL ?? 'https://api.croo.network',
  wsURL:   process.env.CROO_WS_URL  ?? 'wss://api.croo.network/ws',
};

const SERVICE_ID   = process.env.CROO_SERVICE_ID_HYPERLIQUID;
const CUSTOMER_KEY = process.env.CROO_SDK_KEY_WEB_RESEARCH; // buyer = a different key
const VAULT        = '0xdfc24b077bc1425ad1dea75bcb6f8158e10df303';
const INPUT        = JSON.stringify({ vaultAddress: VAULT });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function pollUntil(fn, check, interval = 2000, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await fn();
    if (check(result)) return result;
    process.stdout.write('.');
    await sleep(interval);
  }
  throw new Error('Timed out waiting for condition');
}

async function main() {
  console.log(`\n${B}${C}╔══════════════════════════════════════════════════╗${R}`);
  console.log(`${B}${C}║   CROO STORE — CUSTOMER ORDERING HL VAULT       ║${R}`);
  console.log(`${B}${C}╚══════════════════════════════════════════════════╝${R}`);
  console.log(`${DIM}  Service   : Hyperliquid Vault Analysis ($0.50)${R}`);
  console.log(`${DIM}  Vault     : ${VAULT}${R}`);
  console.log(`${DIM}  Service ID: ${SERVICE_ID}${R}\n`);

  const client = new AgentClient(CROO_CONFIG, CUSTOMER_KEY);
  const t0 = Date.now();

  // ── Step 1: Negotiate ────────────────────────────────────────────────────
  process.stdout.write(`  ${DIM}[1/4] Submitting order to CROO marketplace...${R}`);
  const negotiation = await client.negotiateOrder({ serviceId: SERVICE_ID, requirements: INPUT });
  const negotiationId = negotiation.negotiationId;
  console.log(` ${G}done${R}`);
  console.log(`     Negotiation ID : ${negotiationId}\n`);

  // ── Step 2: Wait for coordinator to accept ───────────────────────────────
  process.stdout.write(`  ${DIM}[2/4] Waiting for Attestr coordinator to accept${R} `);
  const accepted = await pollUntil(
    () => client.getNegotiation(negotiationId),
    n => n.orderId && n.orderId.length > 10,
    2000, 30000
  );
  const orderId = accepted.orderId;
  console.log(` ${G}accepted${R}`);
  console.log(`     Order ID       : ${orderId}`);
  console.log(`     Price          : ${accepted.price ?? '$0.50'} USDC\n`);

  // ── Step 3: Pay ──────────────────────────────────────────────────────────
  process.stdout.write(`  ${DIM}[3/4] Paying order on Base (USDC)...${R}`);
  const payment = await client.payOrder(orderId);
  console.log(` ${G}done${R}`);
  console.log(`     TX Hash        : ${payment.txHash ?? payment}\n`);

  // ── Step 4: Wait for delivery ────────────────────────────────────────────
  process.stdout.write(`  ${DIM}[4/4] Waiting for vault analysis to complete${R} `);
  const order = await pollUntil(
    () => client.getOrder(orderId),
    o => o.status === 'delivered' || o.status === 'rejected',
    3000, 90000
  );

  if (order.status === 'rejected') {
    console.log(` ${RD}rejected${R}\n`);
    console.log(`${RD}${B}  ✗ Order rejected: ${order.rejectionReason}${R}\n`);
    process.exit(1);
  }
  console.log(` ${G}delivered${R}\n`);

  const delivery = await client.getDelivery(orderId);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  // ── Display result ────────────────────────────────────────────────────────
  console.log(`${B}${C}╔══════════════════════════════════════════════════╗${R}`);
  console.log(`${B}${C}║   RESULT DELIVERED TO CUSTOMER                  ║${R}`);
  console.log(`${B}${C}╚══════════════════════════════════════════════════╝${R}\n`);

  try {
    const result = JSON.parse(delivery.deliverableText);
    const badgeCol = result.badge === 'SAFE' ? G : result.badge === 'CAUTION' ? Y : RD;
    console.log(`  ${B}Vault${R}          ${result.name ?? result.vaultAddress}`);
    console.log(`  ${B}TVL${R}            $${(result.tvl ?? 0).toLocaleString()}`);
    console.log(`  ${B}APR${R}            ${result.apr ?? 'N/A'}%`);
    console.log(`  ${B}Commission${R}     ${result.commission ?? 0}%`);
    console.log(`  ${B}Badge${R}          ${badgeCol}${B}${result.badge}${R}  (Score: ${result.riskScore}/100)`);
    console.log(`  ${B}Recommend${R}      ${result.depositRecommendation ?? result.recommendation ?? 'N/A'}`);
    if (result.riskFactors?.length) {
      console.log(`\n  ${B}Risk Factors${R}`);
      result.riskFactors.forEach(f => console.log(`    · ${f}`));
    }
  } catch {
    console.log(`  Raw: ${delivery.deliverableText?.slice(0, 600)}`);
  }

  console.log(`\n${G}${B}  ✅ Full order cycle completed in ${elapsed}s${R}`);
  console.log(`${G}${B}  ✅ USDC paid on Base → analysis delivered → Attestr earned${R}\n`);
}

main().catch(e => {
  console.error(`\n${RD}${B}Error: ${e.message}${R}`);
  if (e.message?.includes('balance'))    console.log(`${Y}  → Not enough USDC in buyer wallet${R}`);
  if (e.message?.includes('Timed out')) console.log(`${Y}  → Coordinator didn't respond in time — check Railway logs${R}`);
  process.exit(1);
});
