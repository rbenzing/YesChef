export const meta = {
  name: 'yeschef-full-service',
  description: 'Brigade service: scout discovers, chef plans tickets, line-cooks implement in parallel, expeditor verifies',
  phases: [
    { title: 'Discover', detail: 'scout digests the task area' },
    { title: 'Plan', detail: 'split into disjoint tickets' },
    { title: 'Cook', detail: 'one line-cook per ticket' },
    { title: 'Verify', detail: 'expeditor gates the result' },
  ],
}

const task = (args && args.task) ? String(args.task) : null
if (!task) return { error: 'no task provided — pass args: { task: "..." }' }

// Brigade agent types come from the plugin registry; fall back to default agents
// carrying the same contract inline if the scoped type is unavailable.
async function brigade(type, prompt, opts) {
  const o = Object.assign({}, opts)
  try {
    return await agent(prompt, Object.assign({}, o, { agentType: type }))
  } catch (e) {
    return await agent(
      `You are acting as the YesChef ${type} (its agent type was unavailable). ` +
      `Honor its contract strictly: terse digest/report, file:line pointers, no raw file dumps.\n\n` + prompt,
      o
    )
  }
}

phase('Discover')
const digest = await brigade('yeschef:scout',
  `Task: ${task}\n\nScout the codebase for everything needed to implement this task. ` +
  `Use mcp__yeschef__folder_desc first, then ONE mcp__yeschef__batch_digest batch. ` +
  `Return your digest per contract: ANSWER / POINTERS (file:line) / CAVEATS, ≤40 lines.`,
  { label: 'scout', phase: 'Discover', model: 'haiku' })

phase('Plan')
const TICKETS = {
  type: 'object',
  required: ['tickets', 'verifyCommand'],
  properties: {
    verifyCommand: { type: 'string', description: 'one command that verifies the whole change set, empty string if none exists' },
    tickets: {
      type: 'array', maxItems: 4,
      items: {
        type: 'object',
        required: ['title', 'instructions', 'files'],
        properties: {
          title: { type: 'string' },
          instructions: { type: 'string', description: 'goal + pointers + scope fence + verify command' },
          files: { type: 'array', items: { type: 'string' }, description: 'files this ticket may touch — MUST be disjoint across tickets' },
        },
      },
    },
  },
}
const plan = await agent(
  `Task: ${task}\n\nScout digest:\n${digest}\n\n` +
  `Split this into 1-4 implementation tickets with STRICTLY DISJOINT file sets (they run in parallel). ` +
  `Each ticket's instructions must contain: one-sentence goal, the relevant file:line pointers from the digest, ` +
  `a scope fence (what NOT to touch), and the narrowest verify command. ` +
  `Also give one verifyCommand for the whole change set. Prefer ONE ticket unless parallelism is clearly safe.`,
  { label: 'plan', phase: 'Plan', schema: TICKETS })

if (!plan || !plan.tickets || plan.tickets.length === 0) {
  return { error: 'planning produced no tickets', digest }
}
log(`${plan.tickets.length} ticket(s) planned`)

phase('Cook')
// The schema can only ASK for disjoint file sets — validate before running
// cooks in parallel, or overlapping tickets race on the same files and one
// cook's edits silently vanish. Overlap -> cook sequentially instead.
const seen = new Map()
let overlap = false
for (const t of plan.tickets) {
  for (const f of t.files || []) {
    if (seen.has(f)) { overlap = true; log(`ticket file overlap on ${f} ("${seen.get(f)}" vs "${t.title}") — cooking sequentially`) }
    seen.set(f, t.title)
  }
}
const cookTicket = (t, i) =>
  brigade('yeschef:line-cook',
    `Ticket: ${t.title}\n\n${t.instructions}\n\nFiles you may touch: ${t.files.join(', ')}. ` +
    `Report per contract: DONE/BLOCKED, CHANGES (file:line), TESTS, NOTES. ≤30 lines.`,
    { label: `cook:${i + 1}-${t.title.slice(0, 24)}`, phase: 'Cook' })
let cooked
if (overlap) {
  cooked = []
  for (let i = 0; i < plan.tickets.length; i++) cooked.push(await cookTicket(plan.tickets[i], i))
} else {
  cooked = await parallel(plan.tickets.map((t, i) => () => cookTicket(t, i)))
}
// A null result is a crashed/skipped cook — surface it as BLOCKED instead of
// silently dropping the ticket from the report set.
const reports = cooked.map((r, i) => r ?? `TICKET ${i + 1} "${plan.tickets[i].title}": BLOCKED — line-cook returned no report (crashed or skipped). Treat as NOT implemented.`)

phase('Verify')
const verdict = await brigade('yeschef:expeditor',
  `Goal: ${task}\n\nCook reports:\n${reports.join('\n---\n')}\n\n` +
  `Verify the merged change set. Whole-set verify command suggested by the plan: ${plan.verifyCommand || '(discover one)'}. ` +
  `Report per contract: VERDICT / EVIDENCE / FINDINGS / UNCHECKED. ≤30 lines.`,
  { label: 'expeditor', phase: 'Verify' })

return {
  task,
  tickets: plan.tickets.map((t) => t.title),
  cookReports: reports,
  failedTickets: cooked.filter((r) => !r).length,
  verdict,
}
