require('dotenv').config({ override: true });

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL   = 'llama-3.3-70b-versatile';
const VAULT        = '0xdfc24b077bc1425ad1dea75bcb6f8158e10df303';

const B = '\x1b[1m', R = '\x1b[0m', G = '\x1b[32m', Y = '\x1b[33m',
      C = '\x1b[36m', RD = '\x1b[31m', DIM = '\x1b[2m';

function extractJson(text) {
  const s = text.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim();
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  const json = i !== -1 && j > i ? s.slice(i, j + 1) : s;
  return json.replace(/"(?:[^"\\]|\\.)*"/g, m =>
    m.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t'));
}

async function groqJson(sys, user) {
  const ji = '\n\nIMPORTANT: Return ONLY valid JSON. Start with { end with }. No markdown.';
  for (let a = 1; a <= 3; a++) {
    const s = a === 1 ? sys + ji : sys + ji + `\nCRITICAL attempt ${a}/3: JSON only.`;
    const res = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model: GROQ_MODEL, messages: [{ role: 'system', content: s }, { role: 'user', content: user }] }),
    });
    const d = await res.json();
    const t = d.choices[0]?.message?.content ?? '';
    try { JSON.parse(extractJson(t)); return t; }
    catch { if (a === 3) throw new Error('Non-JSON after 3 retries'); }
  }
}

async function main() {
  console.log(`\n${B}${C}╔══════════════════════════════════════════════════╗${R}`);
  console.log(`${B}${C}║   CROO STORE — ORDER RECEIVED & PAID            ║${R}`);
  console.log(`${B}${C}╚══════════════════════════════════════════════════╝${R}`);
  console.log(`${DIM}  Service   : Hyperliquid Vault Intelligence Analysis${R}`);
  console.log(`${DIM}  Price     : $0.05 USDC${R}`);
  console.log(`${DIM}  Input     : ${VAULT}${R}`);
  console.log(`${DIM}  Event     : OrderPaid → routing to hyperliquid pipeline...${R}\n`);

  const t0 = Date.now();

  // Step 1 — Live vault data
  process.stdout.write(`  ${DIM}[1/3] Fetching live vault data from Hyperliquid...${R}`);
  const res = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'vaultDetails', vaultAddress: VAULT }),
  });
  const vault = await res.json();

  let tvl = 0;
  for (const [, entry] of vault.portfolio ?? []) {
    const hist = entry?.accountValueHistory ?? [];
    if (hist.length > 0) { const v = parseFloat(hist[hist.length - 1][1]); if (v > tvl) tvl = v; }
  }
  const followers = Array.isArray(vault.followers) ? vault.followers.length : 0;
  console.log(` ${G}done${R}`);
  console.log(`     → ${B}${vault.name}${R} | TVL: ${B}$${(tvl / 1e6).toFixed(2)}M${R} | APR: ${vault.apr}% | Commission: ${vault.leaderCommission}% | Followers: ${followers}\n`);

  // Step 2 — AI risk analysis
  process.stdout.write(`  ${DIM}[2/3] Running AI risk analysis (Groq llama-3.3-70b)...${R}`);
  const t = await groqJson(
    'You are a DeFi analyst specializing in Hyperliquid vault strategies. Calibrated, accurate risk assessments.',
    `Vault: ${vault.name}
Address: ${VAULT}
Leader: ${vault.leader}
TVL: $${tvl.toLocaleString()}
APR: ${vault.apr}%
Commission: ${vault.leaderCommission}% (0% is NORMAL for HLP vault — not a red flag)
Followers: ${followers}
Allow Deposits: ${vault.allowDeposits}
Closed: ${vault.isClosed}

Risk signals: APR>200%=high risk, TVL<$10K=manipulation risk, Commission>20%=reduces returns, Closed=no entry.

Return JSON with exactly these fields:
{
  "badge": "SAFE"|"CAUTION"|"DANGEROUS",
  "riskScore": <integer 0-100>,
  "vaultOverview": "<2-3 sentence summary>",
  "performanceAnalysis": "<paragraph on APR, TVL, sustainability>",
  "riskFactors": ["<risk 1>", "..."],
  "depositRecommendation": "YES"|"NO",
  "recommendationReason": "<1 sentence>"
}
0-30=SAFE, 31-65=CAUTION, 66-100=DANGEROUS. Badge must match score.`,
  );
  const p = JSON.parse(extractJson(t));
  p.riskScore = Math.max(0, Math.min(100, p.riskScore));
  console.log(` ${G}done${R}\n`);

  // Step 3 — Package for delivery
  process.stdout.write(`  ${DIM}[3/3] Packaging deliverable for CROO...${R}`);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(` ${G}done${R}\n`);

  const badgeCol = p.badge === 'SAFE' ? G : p.badge === 'CAUTION' ? Y : RD;
  const recCol   = p.depositRecommendation === 'YES' ? G : RD;

  console.log(`${B}${C}╔══════════════════════════════════════════════════╗${R}`);
  console.log(`${B}${C}║   DELIVERABLE — WHAT THE CUSTOMER RECEIVES      ║${R}`);
  console.log(`${B}${C}╚══════════════════════════════════════════════════╝${R}\n`);

  console.log(`  ${B}Vault Name${R}       ${vault.name}`);
  console.log(`  ${B}Address${R}          ${VAULT}`);
  console.log(`  ${B}Leader${R}           ${vault.leader}`);
  console.log(`  ${B}TVL${R}              $${(tvl / 1e6).toFixed(2)}M`);
  console.log(`  ${B}APR${R}              ${vault.apr}%`);
  console.log(`  ${B}Commission${R}       ${vault.leaderCommission}%`);
  console.log(`  ${B}Followers${R}        ${followers}`);
  console.log(`  ${B}Deposits Open${R}    ${vault.allowDeposits ? 'Yes' : 'No'}`);
  console.log(`  ${B}Vault Closed${R}     ${vault.isClosed ? 'Yes' : 'No'}`);

  console.log(`\n  ─────────────────────────────────────────────────`);
  console.log(`  ${B}Risk Badge${R}       ${badgeCol}${B}${p.badge}${R}  (Score: ${p.riskScore}/100)`);
  console.log(`  ${B}Deposit Rec${R}      ${recCol}${B}${p.depositRecommendation}${R}`);
  console.log(`  ${B}Reason${R}           ${p.recommendationReason}`);

  console.log(`\n  ${B}Vault Overview${R}`);
  console.log(`  ${p.vaultOverview}`);

  console.log(`\n  ${B}Performance Analysis${R}`);
  console.log(`  ${p.performanceAnalysis}`);

  if (p.riskFactors?.filter(Boolean).length) {
    console.log(`\n  ${B}Risk Factors${R}`);
    p.riskFactors.forEach(f => console.log(`    · ${f}`));
  } else {
    console.log(`\n  ${B}Risk Factors${R}     None identified`);
  }

  console.log(`\n${G}${B}  ✅ Order completed in ${elapsed}s — USDC released to Attestr wallet${R}\n`);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
