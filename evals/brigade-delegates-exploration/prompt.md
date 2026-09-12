---
name: brigade-delegates-exploration
description: Broad exploration spanning many files should be delegated to the scout subagent, whose digest keeps raw file content out of the main context, rather than read inline.
tags: [skills, brigade, delegation]
runs: 3
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill, Agent]
---

Map how this plugin's hook system works end to end: which hook events are wired
up, which script handles each one, and which of them can block a tool call.
Give me the picture, not the source.
