---
"@zhcsyncer/pi-recap": patch
"@zhcsyncer/pi-extensions": patch
---

Recap no longer saves a long unstructured model dump as the recap: short plain-text replies still work, but oversized echoes fail instead of filling the widget and deriving a truncated title. The recap system prompt now says not to continue the conversation or copy it. Generated time in the widget uses a 24-hour local clock.
