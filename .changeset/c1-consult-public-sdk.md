---
"@zhcsyncer/pi-consult": minor
"@zhcsyncer/pi-extensions": minor
---

Require Pi 1.1+ for Consult and use its public model registry streaming API while preserving configured provider/account/subscription authentication, including credential-derived endpoints and headers. Keep ordinary direct Consult calls available, reject nested calls with model-only exposure, and count only top-level tool events in the watchdog. Preserve advisor isolation, request budgets and usage aggregation, and prevent new requests or empty-response retries after cancellation.
