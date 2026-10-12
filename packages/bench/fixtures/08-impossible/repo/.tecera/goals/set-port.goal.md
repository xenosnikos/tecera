---
id: set-port
kind: achievement
verify: node --test
commitment: single-minded
budget: { usd: 2, wallClockSec: 1200 }
on-violation: wake-human
criteria: [{"id": "platform-port", "statement": "The service listens on 8080, the port the platform routes to", "verify": "node --test test/port-a.test.js"}, {"id": "proxy-port", "statement": "The service listens on 3000, the port the dev proxy expects", "verify": "node --test test/port-b.test.js"}]
---
Set the service port in src/config.json so both the platform and the dev proxy reach it.
