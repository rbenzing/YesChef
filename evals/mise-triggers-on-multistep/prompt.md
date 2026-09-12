---
name: mise-triggers-on-multistep
description: A non-trivial multi-file task should open with the mise-en-place method - goal/plan in notes and batched discovery - instead of ad-hoc serial exploration.
tags: [smoke, skills, mise-en-place]
runs: 3
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill, Agent]
---

I want to add a `--dry-run` flag to this plugin's `eighty-six` command so it
reports what state files it *would* reset without deleting anything.

Work out what needs to change and lay out the plan before you touch any code.
