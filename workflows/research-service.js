export const meta = {
  name: 'yeschef-research-service',
  description: 'Brigade research: plan angles, sweep sources in parallel, cross-check claims, synthesize a cited report',
  phases: [
    { title: 'Angles', detail: 'split the question into distinct search angles' },
    { title: 'Sweep', detail: 'one researcher per angle, in parallel' },
    { title: 'Cross-check', detail: 'adversarially verify load-bearing claims' },
    { title: 'Synthesize', detail: 'one cited report' },
  ],
}

const question = (args && args.question) ? String(args.question) : null
if (!question) return { error: 'no question provided — pass args: { question: "..." }' }

async function brigade(type, prompt, opts) {
  const o = Object.assign({}, opts)
  try {
    return await agent(prompt, Object.assign({}, o, { agentType: type }))
  } catch (e) {
    return await agent(
      `You are acting as the YesChef ${type}. Contract: ≤40-line digest, claims with source URLs and confidence tags, no page dumps.\n\n` + prompt,
      o
    )
  }
}

phase('Angles')
const ANGLES = {
  type: 'object',
  required: ['angles'],
  properties: {
    angles: {
      type: 'array', minItems: 2, maxItems: 4,
      items: { type: 'object', required: ['name', 'brief'], properties: { name: { type: 'string' }, brief: { type: 'string' } } },
    },
  },
}
const planned = await agent(
  `Research question: ${question}\n\nSplit this into 2-4 DISTINCT search angles (different facets/source types, not rephrasings). ` +
  `Each angle gets a one-line name and a 2-3 sentence brief telling a researcher what to establish.`,
  { label: 'angles', phase: 'Angles', schema: ANGLES })

// agent() returns null on crash/skip despite the schema — fail gracefully
// instead of TypeError-ing after zero work.
if (!planned || !Array.isArray(planned.angles) || planned.angles.length === 0) {
  return { error: 'angle planning failed — no angles returned', question }
}
log(`${planned.angles.length} angle(s)`)

phase('Sweep')
const CLAIMS = {
  type: 'object',
  required: ['claims'],
  properties: {
    answer: { type: 'string' },
    claims: {
      type: 'array',
      items: {
        type: 'object', required: ['claim', 'source', 'confidence'],
        properties: { claim: { type: 'string' }, source: { type: 'string' }, confidence: { type: 'string', enum: ['solid', 'single-source', 'disputed'] } },
      },
    },
    gaps: { type: 'array', items: { type: 'string' } },
  },
}
const sweeps = await parallel(planned.angles.map((a, i) => () =>
  brigade('yeschef:researcher',
    `Question: ${question}\nYour angle: ${a.name} — ${a.brief}\nResearch this angle per your contract and return structured claims.`,
    { label: `research:${a.name.slice(0, 24)}`, phase: 'Sweep', schema: CLAIMS })
))

const allClaims = sweeps.filter(Boolean).flatMap((s) => s.claims || [])
const loadBearing = allClaims.filter((c) => c.confidence !== 'solid').slice(0, 8)
log(`${allClaims.length} claims gathered, ${loadBearing.length} need cross-checking`)

phase('Cross-check')
const VERDICT = {
  type: 'object',
  required: ['verdict'],
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'refuted', 'unresolved'] },
    note: { type: 'string' },
    source: { type: 'string' },
  },
}
const checked = await parallel(loadBearing.map((c) => () =>
  agent(
    `Try to REFUTE this claim with an independent source (do not reuse ${c.source}): "${c.claim}". ` +
    `Search for contradicting evidence. Default to 'unresolved' if you cannot find independent confirmation either way.`,
    { label: `check:${c.claim.slice(0, 28)}`, phase: 'Cross-check', schema: VERDICT }
  ).then((v) => (v ? { claim: c, check: v } : null)) // null verdict -> drop the wrapper too, or .check.verdict derefs null below
))

phase('Synthesize')
const survivors = allClaims.filter((c) => {
  const chk = checked.filter(Boolean).find((x) => x.claim === c)
  return !chk || chk.check.verdict !== 'refuted'
})
const report = await agent(
  `Question: ${question}\n\nVerified claim set (refuted claims already removed):\n` +
  survivors.map((c) => `- ${c.claim} [${c.confidence}] (${c.source})`).join('\n') +
  `\n\nCross-check outcomes:\n` +
  checked.filter(Boolean).map((x) => `- ${x.check.verdict}: ${x.claim.claim.slice(0, 90)}${x.check.note ? ` — ${x.check.note}` : ''}`).join('\n') +
  `\n\nWrite the final research report: direct answer first, then supporting sections, every claim cited inline with its URL, ` +
  `disagreements and gaps stated honestly. Be complete but not padded.`,
  { label: 'synthesize', phase: 'Synthesize' })

return { question, report, claimCount: allClaims.length, refuted: checked.filter(Boolean).filter((x) => x.check.verdict === 'refuted').length }
