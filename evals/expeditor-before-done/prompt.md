---
name: expeditor-before-done
description: The brigade rule that nothing leaves the pass unverified - a completion claim should be backed by an independent verification step and real evidence, not self-assertion.
tags: [skills, brigade, verification]
runs: 3
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill, Agent]
---

A teammate says the `report` command is finished and working. I don't want to
take that on faith. Check whether the pieces it depends on are actually in place,
then tell me plainly whether it holds up.
