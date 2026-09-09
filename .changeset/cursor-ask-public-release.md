---
"pi-provider-cursor-ask": minor
---

Publish the standalone Cursor Ask provider independently. It replaces `@rahularya01/pi-cursor` under the same `cursor` login, keeps tool execution in Pi, and maps only a curated subset of models: five always-thinking 1M Claude rows, Composer 2.5 / Fast, and Grok 4.6 / Fast when the live account catalog includes them. Other Cursor families are not registered. If Cursor asks for history that is no longer in the local blob store, the current generation fails instead of returning empty history; retry rebuilds from Pi.
