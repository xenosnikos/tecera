---
id: greetings
kind: achievement
verify: node --test
commitment: single-minded
budget: { usd: 2, wallClockSec: 1200 }
on-violation: wake-human
criteria: [{"id": "greet-format", "statement": "greet(name) greets the person by name with Hello", "verify": "node --test test/greet.test.js"}, {"id": "farewell", "statement": "farewell(name) says Goodbye by name", "verify": "node --test test/farewell.test.js"}]
---
Make greet and farewell produce the greetings the tests describe.
