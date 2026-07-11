require('dotenv').config({ override: true });

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL   = 'llama-3.3-70b-versatile';

function extractJson(text) {
  const stripped = text.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim();
  const start = stripped.indexOf('{');
  const end   = stripped.lastIndexOf('}');
  const json  = start !== -1 && end > start ? stripped.slice(start, end + 1) : stripped;
  return json.replace(/"(?:[^"\\]|\\.)*"/g, m =>
    m.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t'));
}

async function groqJson(sys, user) {
  const ji = '\n\nIMPORTANT: Return ONLY valid JSON. No text before or after. No markdown. Start with { end with }';
  for (let a = 1; a <= 3; a++) {
    try {
      const res = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
        body: JSON.stringify({ model: GROQ_MODEL, messages: [{ role: 'system', content: sys + ji }, { role: 'user', content: user }], response_format: { type: 'json_object' } }),
      });
      const d = await res.json();
      const text = d.choices[0]?.message?.content ?? '';
      return JSON.stringify(JSON.parse(extractJson(text)));
    } catch (e) {
      if (a === 3) throw e;
    }
  }
}

async function runHyperliquid(vaultAddress) {
  const res = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'vaultDetails', vaultAddress }),
  });
  const vault = await res.json();

  let tvl = 0;
  for (const [, entry] of vault.portfolio ?? []) {
    const hist = entry?.accountValueHistory ?? [];
    if (hist.length > 0) { const v = parseFloat(hist[hist.length-1][1]); if (v > tvl) tvl = v; }
  }
  const followers = Array.isArray(vault.followers) ? vault.followers.length : 0;

  const t = await groqJson(
    'You are a DeFi analyst specializing in Hyperliquid vault strategies. Calibrated, accurate risk assessments.',
    `Vault: ${vault.name}\nAddress: ${vaultAddress}\nLeader: ${vault.leader}\nTVL: $${tvl.toLocaleString()}\nAPR: ${vault.apr}%\nCommission: ${vault.leaderCommission}% (0% is NORMAL for HLP — not a red flag)\nFollowers: ${followers}\nAllow Deposits: ${vault.allowDeposits}\nClosed: ${vault.isClosed}\n\nRisk signals: APR>200%=unsustainable, TVL<$10K=manipulation risk, Commission>20%=reduces returns, Closed=no entry.\n\nReturn JSON: {"badge":"SAFE"|"CAUTION"|"DANGEROUS","riskScore":0,"depositRecommendation":"YES"|"NO","recommendationReason":"...","riskFactors":["..."]}\n0-30=SAFE+YES,31-65=CAUTION,66-100=DANGEROUS+NO.`,
  );
  const p = JSON.parse(extractJson(t));
  return { ...p, name: vault.name, tvl, apr: vault.apr, commission: vault.leaderCommission, followers, riskScore: Math.max(0, Math.min(100, p.riskScore)) };
}

(async () => {
  const vault = '0xdfc24b077bc1425ad1dea75bcb6f8158e10df303';
  const B = '\x1b[1m', G = '\x1b[32m', R = '\x1b[0m', Y = '\x1b[33m', C = '\x1b[36m';

  console.log(`${C}${B}Testing Hyperliquid Vault Analysis${R}`);
  console.log(`${Y}Input: ${vault}${R}\n`);

  const start = Date.now();
  const r = await runHyperliquid(vault);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`${G}${B}✅ SUCCESS${R} — ${elapsed}s`);
  console.log(`  Vault      : ${B}${r.name}${R}`);
  console.log(`  TVL        : $${r.tvl.toLocaleString()}`);
  console.log(`  APR        : ${r.apr}%`);
  console.log(`  Commission : ${r.commission}%`);
  console.log(`  Followers  : ${r.followers}`);
  console.log(`  Badge      : ${G}${B}${r.badge}${R} (${r.riskScore}/100)`);
  console.log(`  Rec        : ${B}${r.depositRecommendation}${R}`);
  console.log(`  Reason     : ${r.recommendationReason}`);
  console.log(`  Risk Factors: ${(r.riskFactors || []).join(', ') || 'none'}`);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
