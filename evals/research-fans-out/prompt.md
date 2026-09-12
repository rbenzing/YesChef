---
name: research-fans-out
description: An external research question should fan out to researcher subagents and come back as cited claims with confidence, never as raw page dumps in the main context.
tags: [skills, brigade, research]
runs: 3
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill, Agent]
---

I need to understand the tradeoffs between the different Claude Code hook events
for enforcing policy on tool calls — specifically which ones can actually block
an action versus only observe it, and what the cost of each is. Research this
properly and report back.
