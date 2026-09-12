---
type: llm
focus: trace
weight: 2
---

Judge only HOW the assistant gathered information, not whether its plan was correct.

PASS if discovery was front-loaded and batched: the assistant issued several
search/read/delegation calls together in one step (or delegated exploration to a
subagent) before reasoning about the change.

FAIL if discovery was serial and reactive — one read, then a comment, then
another read, then another comment — or if the assistant read whole large files
when a targeted search would have answered the question.
