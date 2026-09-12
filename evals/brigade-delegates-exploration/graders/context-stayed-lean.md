---
type: llm
focus: trace
weight: 2
---

Judge whether raw file content was kept OUT of the main conversation.

PASS if the assistant delegated the exploration to a subagent and worked from the
returned digest, or read only narrow targeted ranges — the main transcript
contains pointers and summaries rather than large file dumps.

FAIL if the main transcript contains the full text of several files, or if the
assistant read many files one after another inline when a subagent was available.
