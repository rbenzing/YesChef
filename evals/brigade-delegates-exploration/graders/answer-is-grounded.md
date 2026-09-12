---
type: llm
weight: 1
---

PASS if the answer names specific hook events (for example SessionStart,
UserPromptSubmit, PreToolUse, PostToolUse, Stop) mapped to the scripts that
handle them, and correctly identifies that the PreToolUse handler is the one able
to block a tool call.

FAIL if the mapping is absent, largely wrong, or if the answer is a generic
description of Claude Code hooks that is not specific to this repository.
