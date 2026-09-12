---
type: llm
weight: 1
---

PASS if the final message states a goal and an ordered, concrete plan of the
smallest verifiable steps, each naming a real file or component it touches, and
does NOT claim the change has already been implemented.

FAIL if the plan is vague ("update the command, then test it"), names no
specific files, or if the assistant edited code despite being asked to plan first.
