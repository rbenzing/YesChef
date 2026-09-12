---
type: llm
weight: 2
arm: both
---

PASS if the final message reaches a clear verdict (holds up / does not hold up /
cannot tell) AND grounds it in specific evidence actually gathered — named files
or paths that were found or missing, such as whether the command's referenced
build output exists.

FAIL if the verdict is asserted without evidence, if it merely restates the
teammate's claim, or if it hedges without saying what was checked.
