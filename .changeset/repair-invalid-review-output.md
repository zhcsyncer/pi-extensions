---
"@zhcsyncer/pi-adversarial-review": minor
---

Give reviewer `invalid-output` routes one same-model, same-thinking format-repair attempt before convergence. The repair role has no tools, extensions, skills, frozen-input path, or review assignment; receives only the parser error and original raw output; and is bounded to three turns, two wrap-up turns, two minutes, and the remaining original review deadline. Host-side provenance validation accepts a retry only when it is identical to the one complete schema-valid ReviewReport already embedded in the original output, so missing, truncated, ambiguous, invented, or semantically changed reports remain invalid. Persist both attempts and their combined usage/duration in the final audit and surface repair state in progress/report UI.
