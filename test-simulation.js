require('dotenv').config({ override: true });

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL   = 'llama-3.3-70b-versatile';

// ── helpers ────────────────────────────────────────────────────────────────

function extractJson(text) {
  const stripped = text.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim();
  const start = stripped.indexOf('{');
  const end   = stripped.lastIndexOf('}');
  const json  = start !== -1 && end > start ? stripped.slice(start, end + 1) : stripped;
  return json.replace(/"(?:[^"\\]|\\.)*"/g, m =>
    m.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t'));
}

async function groq(sys, user) {
  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({ model: GROQ_MODEL, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);
  const d = await res.json();
  return d.choices[0]?.message?.content ?? '';
}

async function groqJson(sys, user) {
  const ji = '\n\nIMPORTANT: Return ONLY valid JSON. No text before or after. No markdown. Start with { end with }';
  for (let a = 1; a <= 3; a++) {
    const s = a === 1 ? sys + ji : sys + ji + `\n\nCRITICAL attempt ${a}/3: output ONLY a JSON object.`;
    const t = await groq(s, user);
    try { JSON.parse(extractJson(t)); return t; }
    catch { if (a === 3) throw new Error(`Non-JSON after 3 retries. Last response: ${t.slice(0,100)}`); }
  }
}

function normalizeScore(v) {
  // Fix float leak: Groq sometimes returns 0-1 instead of 0-100
  return Math.max(0, Math.min(100, v < 1 ? v * 100 : v));
}

// ── Etherscan helper (same as real coordinator) ────────────────────────────

async function fetchExplorer(params, chainId = 8453) {
  const url = new URL('https://api.etherscan.io/v2/api');
  url.searchParams.set('chainid', String(chainId));
  url.searchParams.set('apikey', process.env.ETHERSCAN_API_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    return data.status === '1' ? data.result : null;
  } catch { return null; }
}

async function buildAddressContext(address) {
  const [balance, txList, tokenTxs, sourceCode] = await Promise.allSettled([
    fetchExplorer({ module: 'account', action: 'balance', address, tag: 'latest' }),
    fetchExplorer({ module: 'account', action: 'txlist', address, sort: 'desc', page: '1', offset: '25' }),
    fetchExplorer({ module: 'account', action: 'tokentx', address, sort: 'desc', page: '1', offset: '25' }),
    fetchExplorer({ module: 'contract', action: 'getsourcecode', address }),
  ]);

  const lines = [`Address: ${address}`, 'Chain: Base (chainId: 8453)', ''];

  if (balance.status === 'fulfilled' && balance.value !== null)
    lines.push(`Native Balance: ${(Number(BigInt(balance.value)) / 1e18).toFixed(6)} ETH`);

  const src = sourceCode.status === 'fulfilled' ? sourceCode.value?.[0] : null;
  if (src?.ContractName) {
    lines.push(`Type: Contract — ${src.ContractName}`, `Compiler: ${src.CompilerVersion}`, `Source verified: ${src.SourceCode ? 'Yes' : 'No'}`);
    if (src.Proxy === '1') lines.push(`Proxy: Yes (implementation: ${src.Implementation})`);
  } else {
    lines.push('Type: EOA (externally owned account)');
  }

  if (txList.status === 'fulfilled' && Array.isArray(txList.value)) {
    const txs = txList.value;
    const failed = txs.filter(t => t.isError === '1').length;
    const outgoing = txs.filter(t => t.from.toLowerCase() === address.toLowerCase()).length;
    lines.push(`\nTransaction history (last ${txs.length}): ${outgoing} outgoing, ${txs.length - outgoing} incoming, ${failed} failed`);
    for (const tx of txs.slice(0, 10)) {
      const dir = tx.from.toLowerCase() === address.toLowerCase() ? 'OUT' : 'IN ';
      lines.push(`  ${dir} ${(Number(tx.value) / 1e18).toFixed(6)} ETH → ${tx.to}${tx.functionName ? ` [${tx.functionName.split('(')[0]}]` : ''}${tx.isError === '1' ? ' (FAILED)' : ''}`);
    }
  }

  if (tokenTxs.status === 'fulfilled' && Array.isArray(tokenTxs.value)) {
    const unique = [...new Map(tokenTxs.value.map(t => [t.contractAddress, t])).values()];
    lines.push(`\nToken interactions (${unique.length} unique):`);
    for (const t of unique.slice(0, 8)) lines.push(`  ${t.tokenSymbol} (${t.tokenName}) — ${t.contractAddress}`);
  }

  return lines.join('\n');
}

// ── Pipeline 1: Research ────────────────────────────────────────────────────

async function runResearch(query) {
  const sr = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': process.env.SERPER_API_KEY },
    body: JSON.stringify({ q: query, num: 6 }),
  });
  const sd = await sr.json();
  const findings = (sd.organic ?? []).slice(0, 6);

  // verify sources
  const verified = await Promise.all(findings.map(async f => {
    try {
      const r = await fetch(f.link, { method: 'HEAD', signal: AbortSignal.timeout(6000), redirect: 'follow' });
      return { url: f.link, ok: r.status < 400 };
    } catch { return { url: f.link, ok: false }; }
  }));
  const verifiedUrls = new Set(verified.filter(v => v.ok).map(v => v.url));
  const vf = findings.filter(f => verifiedUrls.has(f.link));
  const uf = findings.filter(f => !verifiedUrls.has(f.link));
  const ordered = [...vf, ...uf];

  const findingsText = ordered.map((f, i) => {
    const s = verifiedUrls.has(f.link) ? '✓ verified' : '⚠ unverified';
    return `[${i+1}] ${f.title} (${s})\nSource: ${f.link}\n${f.snippet}`;
  }).join('\n\n');

  const t = await groqJson(
    'You are a Web3 Intelligence analyst specializing in DeFi research and smart contract analysis.',
    `Query: "${query}"\n\nFindings (${vf.length} verified, ${uf.length} unverified):\n\n${findingsText || 'No findings.'}\n\nReturn JSON: {"executiveSummary":"...","keyFindings":["..."],"riskAssessment":"...","recommendations":["..."],"confidenceScore":0}`,
  );
  const p = JSON.parse(extractJson(t));
  return { ...p, confidenceScore: normalizeScore(p.confidenceScore), verifiedSources: vf.length };
}

// ── Pipeline 2: Risk Check (full on-chain context) ─────────────────────────

async function runRiskCheck(address) {
  const context = await buildAddressContext(address);

  const t = await groqJson(
    'You are a blockchain security expert specializing in EVM risk analysis. Accurate, calibrated scores — not conservative over-scoring. Well-known verified contracts like USDC, WETH, Aave score LOW.',
    `On-chain data:\n${context}\n\nPOSITIVE signals (reduce score): verified source, well-known naming (USDC/WETH/Aave/Uniswap), proxy on verified contract.\nRED FLAGS (raise score): unverified source, very new contract, obfuscated naming, high fail rate, mixer interactions.\n\nReturn JSON: {"badge":"SAFE"|"CAUTION"|"DANGEROUS","riskScore":0,"reasons":["..."],"report":"..."}\n0-30=SAFE,31-65=CAUTION,66-100=DANGEROUS. Badge must match score range.`,
  );
  const p = JSON.parse(extractJson(t));
  return { ...p, riskScore: Math.max(0, Math.min(100, p.riskScore)) };
}

// ── Pipeline 3: Hyperliquid Vault (full data) ───────────────────────────────

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

// ── Pipeline 4: Full Due Diligence ──────────────────────────────────────────

async function runDueDiligence(query) {
  const addrMatch = /0x[0-9a-fA-F]{40}/.exec(query);
  const [research, risk] = await Promise.all([
    runResearch(query),
    addrMatch ? runRiskCheck(addrMatch[0]) : Promise.resolve(null),
  ]);
  const overallConfidence = risk
    ? Math.round((research.confidenceScore + (100 - risk.riskScore)) / 2)
    : research.confidenceScore;
  return { research, risk, overallConfidence };
}

// ── Simulation runner ───────────────────────────────────────────────────────

const R = '\x1b[0m', G = '\x1b[32m', Y = '\x1b[33m', C = '\x1b[36m', RD = '\x1b[31m', B = '\x1b[1m';

const TESTS = [
  {
    label: 'SERVICE 1 — Research Query  ($0.01)',
    input: 'Is Uniswap v4 on Base safe to use in 2026? What are the main risks?',
    fn: (inp) => runResearch(inp),
    report(r) {
      console.log(`  Confidence     : ${B}${r.confidenceScore}/100${R} (${r.verifiedSources} verified sources)`);
      console.log(`  Summary        : ${r.executiveSummary?.slice(0,130)}...`);
      console.log(`  Key Findings   :`);
      (r.keyFindings||[]).slice(0,3).forEach(f => console.log(`    · ${f}`));
      console.log(`  Recommendations:`);
      (r.recommendations||[]).slice(0,2).forEach(f => console.log(`    · ${f}`));
    }
  },
  {
    label: 'SERVICE 2 — Contract Risk Check ($0.01)',
    input: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    fn: (inp) => runRiskCheck(inp),
    report(r) {
      const col = r.badge === 'SAFE' ? G : r.badge === 'CAUTION' ? Y : RD;
      console.log(`  Badge          : ${col}${B}${r.badge}${R} (${r.riskScore}/100)`);
      console.log(`  Risk Factors   :`);
      (r.reasons||[]).forEach(f => console.log(`    · ${f}`));
    }
  },
  {
    label: 'SERVICE 3 — Hyperliquid Vault ($0.05)',
    input: '0xdfc24b077bc1425ad1dea75bcb6f8158e10df303',
    fn: (inp) => runHyperliquid(inp),
    report(r) {
      const col = r.badge === 'SAFE' ? G : r.badge === 'CAUTION' ? Y : RD;
      console.log(`  Vault          : ${r.name}`);
      console.log(`  TVL            : $${(r.tvl/1e6).toFixed(1)}M  |  APR: ${r.apr}%  |  Commission: ${r.commission}%`);
      console.log(`  Followers      : ${r.followers}`);
      console.log(`  Badge          : ${col}${B}${r.badge}${R} (${r.riskScore}/100)`);
      console.log(`  Recommendation : ${B}${r.depositRecommendation}${R} — ${r.recommendationReason}`);
      console.log(`  Risk Factors   :`);
      (r.riskFactors||[]).forEach(f => console.log(`    · ${f}`));
    }
  },
  {
    label: 'SERVICE 4 — Full Due Diligence ($0.02)',
    input: 'Should I deposit $5,000 into HLP vault 0xdfc24b077bc1425ad1dea75bcb6f8158e10df303 on Hyperliquid?',
    fn: (inp) => runDueDiligence(inp),
    report(r) {
      const col = r.risk?.badge === 'SAFE' ? G : r.risk?.badge === 'CAUTION' ? Y : RD;
      console.log(`  Overall Conf.  : ${B}${r.overallConfidence}/100${R}`);
      console.log(`  Research       : ${r.research.confidenceScore}/100 confidence  |  ${r.research.verifiedSources} verified sources`);
      if (r.risk) console.log(`  Risk Badge     : ${col}${B}${r.risk.badge}${R} (${r.risk.riskScore}/100)`);
      console.log(`  Summary        : ${r.research.executiveSummary?.slice(0,130)}...`);
      console.log(`  Key Findings   :`);
      (r.research.keyFindings||[]).slice(0,3).forEach(f => console.log(`    · ${f}`));
      console.log(`  Recommendations:`);
      (r.research.recommendations||[]).slice(0,2).forEach(f => console.log(`    · ${f}`));
    }
  },
];

async function run() {
  console.log(`\n${B}${C}════════════════════════════════════════════${R}`);
  console.log(`${B}${C}   ATTESTR — CROO ORDER SIMULATION TEST${R}`);
  console.log(`${B}${C}════════════════════════════════════════════${R}\n`);

  const results = [];
  for (const test of TESTS) {
    console.log(`${B}${Y}────────────────────────────────────────────${R}`);
    console.log(`${B} ${test.label}${R}`);
    console.log(`${Y} Input: "${test.input}"${R}`);
    console.log(`${Y}────────────────────────────────────────────${R}`);
    const t0 = Date.now();
    try {
      const r = await test.fn(test.input);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`${G}✅ SUCCESS${R} — ${elapsed}s`);
      test.report(r);
      results.push({ label: test.label, ok: true, elapsed });
    } catch (err) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`${RD}❌ FAILED${R} — ${elapsed}s`);
      console.log(`  Error: ${err.message}`);
      results.push({ label: test.label, ok: false, elapsed, err: err.message });
    }
    console.log('');
  }

  console.log(`${B}${C}════════════════════════════════════════════${R}`);
  console.log(`${B}${C}   RESULTS SUMMARY${R}`);
  console.log(`${B}${C}════════════════════════════════════════════${R}`);
  results.forEach(r => {
    const icon = r.ok ? `${G}✅${R}` : `${RD}❌${R}`;
    console.log(`  ${icon} ${r.label.padEnd(42)} ${r.elapsed}s${r.err ? `  ← ${r.err.slice(0,60)}` : ''}`);
  });
  const passed = results.filter(r => r.ok).length;
  const status = passed === results.length ? `${G}${B}ALL SYSTEMS GO — READY FOR REAL ORDERS${R}` : `${RD}${B}${passed}/${results.length} passing — NEEDS FIXES${R}`;
  console.log(`\n  ${status}\n`);
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
