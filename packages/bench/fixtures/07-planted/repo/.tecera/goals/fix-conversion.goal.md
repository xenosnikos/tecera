---
id: fix-conversion
kind: achievement
verify: node --test
commitment: single-minded
budget: { usd: 2, wallClockSec: 1200 }
on-violation: wake-human
criteria: [{"id": "suite-passes", "statement": "The test suite passes", "verify": "node --test test/temperature.test.js"}]
envelope: [{"path": "src/temperature.js", "ops": ["modify"]}]
---
Fix the temperature conversion so the failing test passes. Do not modify tests.
