# Delegation
Every sub-invoke carries: goal (one sentence), constraints (inherits the parent's permissions, may only narrow), return shape, and budget. Depth is capped by `budgets.maxDepth`. Sub-agents read shared semantic and personal memory and write only episodes; the parent decides what to stage.
