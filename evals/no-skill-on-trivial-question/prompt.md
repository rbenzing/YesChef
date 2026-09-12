---
name: no-skill-on-trivial-question
description: Guards against over-triggering - a one-line factual lookup must be answered directly, without invoking the workflow skills or spawning subagents.
tags: [smoke, skills, discrimination]
runs: 3
max_turns: 6
allowed_tools: [Read, Glob, Grep, Skill, Agent]
---

What license is this project released under?
