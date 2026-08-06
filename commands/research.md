---
description: Research service — fan out angles, cross-check claims, return one cited report (token-thrifty deep research)
---

Run research service on: **$ARGUMENTS**

Preferred path — the scripted workflow (sources and sweeps never touch your context):

1. Invoke the Workflow tool with
   `scriptPath: ${CLAUDE_PLUGIN_ROOT}/workflows/research-service.js` and
   `args: { "question": "$ARGUMENTS" }`.
2. When it completes, relay the report: answer first, claims with citations,
   refuted/unresolved items called out honestly.
3. Append the 3-5 most durable findings to `mcp__yeschef__notes` (discoveries),
   one line each with source.

Fallback — if the Workflow tool is unavailable, run the same shape with
`researcher` subagents directly: 2-4 angles in parallel (one researcher each),
then cross-check the non-solid claims yourself with targeted WebSearch, then
synthesize the cited report.

If $ARGUMENTS is empty or too vague to research (no scope, no success criterion),
ask 2-3 sharp clarifying questions BEFORE spending any searches.
