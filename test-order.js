require('dotenv').config({ override: true });
const { AgentClient } = require('@croo-network/sdk');

const B='\x1b[1m',R='\x1b[0m',G='\x1b[32m',Y='\x1b[33m',C='\x1b[36m',RD='\x1b[31m',DIM='\x1b[2m';

const CROO_CONFIG = {
  baseURL: process.env.CROO_API_URL ?? 'https://api.croo.network',
  wsURL:   process.env.CROO_WS_URL  ?? 'wss://api.croo.network/ws',
};

const SERVICE_ID   = process.env.CROO_SERVICE_ID_RISK_CHECK;
const CUSTOMER_KEY = process.env.CROO_SDK_KEY_RISK;
const INPUT        = JSON.stringify({ address: '0x4200000000000000000000000000000000000006' });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function pollUntil(fn, check, interval = 2000, timeout = 30000) {
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
  console.log(`${B}${C}║   CROO STORE — CUSTOMER PLACING ORDER           ║${R}`);
  console.log(`${B}${C}╚══════════════════════════════════════════════════╝${R}`);
  console.log(`${DIM}  Service   : Contract & Address Risk Check ($0.01)${R}`);
  console.log(`${DIM}  Input     : 0x4200000000000000000000000000000000000006 (WETH on Base)${R}`);
  console.log(`${DIM}  Service ID: ${SERVICE_ID}${R}\n`);

  const client = new AgentClient(CROO_CONFIG, CUSTOMER_KEY);
  const t0 = Date.now();

  // ── Step 1: Negotiate ────────────────────────────────────────────────────
  process.stdout.write(`  ${DIM}[1/4] Submitting order to CROO marketplace...${R}`);
  const negotiation = await client.negotiateOrder({ serviceId: SERVICE_ID, requirements: INPUT });
  const negotiationId = negotiation.negotiationId;
  console.log(` ${G}done${R}`);
  console.log(`     Negotiation ID : ${negotiationId}\n`);

  // ── Step 2: Wait for coordinator to accept (Railway picks this up) ───────
  process.stdout.write(`  ${DIM}[2/4] Waiting for Attestr agent to accept${R} ${Y}(watch Railway logs!)${R} `);
  const accepted = await pollUntil(
    () => client.getNegotiation(negotiationId),
    n => n.orderId && n.orderId.length > 10,
    2000, 30000
  );
  const orderId = accepted.orderId;
  console.log(` ${G}accepted${R}`);
  console.log(`     Order ID       : ${orderId}`);
  console.log(`     Price          : ${accepted.price ?? '~$0.01'} USDC\n`);

  // ── Step 3: Pay ──────────────────────────────────────────────────────────
  process.stdout.write(`  ${DIM}[3/4] Paying order on Base (USDC)...${R}`);
  const payment = await client.payOrder(orderId);
  console.log(` ${G}done${R}`);
  console.log(`     TX Hash        : ${payment.txHash ?? payment}\n`);

  // ── Step 4: Wait for delivery ────────────────────────────────────────────
  process.stdout.write(`  ${DIM}[4/4] Waiting for agent to deliver result${R} ${Y}(pipeline running on Railway...)${R} `);
  const order = await pollUntil(
    () => client.getOrder(orderId),
    o => o.status === 'delivered',
    3000, 60000
  );
  console.log(` ${G}delivered${R}\n`);

  const delivery = await client.getDelivery(orderId);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  // ── Display result ────────────────────────────────────────────────────────
  console.log(`${B}${C}╔══════════════════════════════════════════════════╗${R}`);
  console.log(`${B}${C}║   RESULT RECEIVED BY CUSTOMER                   ║${R}`);
  console.log(`${B}${C}╚══════════════════════════════════════════════════╝${R}\n`);

  try {
    const result = JSON.parse(delivery.deliverableText);
    const badgeCol = result.badge === 'SAFE' ? G : result.badge === 'CAUTION' ? Y : RD;
    console.log(`  ${B}Address${R}       ${result.address}`);
    console.log(`  ${B}Badge${R}         ${badgeCol}${B}${result.badge}${R}  (Score: ${result.riskScore}/100)`);
    console.log(`\n  ${B}Risk Factors${R}`);
    (result.reasons || []).forEach(r => console.log(`    · ${r}`));
    if (result.report) {
      console.log(`\n  ${B}Report Preview${R}`);
      console.log(`  ${result.report.slice(0, 300)}...`);
    }
  } catch {
    console.log(`  Raw: ${delivery.deliverableText?.slice(0, 400)}`);
  }

  console.log(`\n${G}${B}  ✅ Full order cycle completed in ${elapsed}s${R}`);
  console.log(`${G}${B}  ✅ USDC paid on-chain → result delivered → Attestr earned${R}\n`);
}

main().catch(e => {
  console.error(`\n${RD}${B}Error: ${e.message}${R}`);
  if (e.message?.includes('balance'))    console.log(`${Y}  → Not enough USDC on the customer SDK key wallet${R}`);
  if (e.message?.includes('Timed out')) console.log(`${Y}  → Coordinator didn't respond in time — check Railway logs${R}`);
  process.exit(1);
});
