# @tecera/contracts

Types and schemas shared by every Tecera package: the business-case manifest (`tecera.json`), the BDI
vocabulary (beliefs, goals, plans, intentions, steps), the event catalog, reflex questions, worker
spans/effects, and the ports (`Bus`, `Ledger`, `Reflex`, `LLM`, `Worker`, `Tool`, `Board`, `Hook`).
No runtime dependencies except `zod` for schema validation. Nothing here performs I/O.
