# Questions for Unclear Project Constraints

Choose the questions needed to resolve the current uncertainty about the project's intent.

## Product priorities and tradeoffs

- What tradeoff does this project choose on purpose, even if another team might choose differently?
- What kind of working solution would still be unacceptable here, and why?
- Which is worse here: missing data, stale data, wrong data, or slow data?

## Architecture and behavior

- What must stay true about module boundaries, dependencies, or state transitions?
- Where should data preparation and decision logic live, and why?
- Which recurring review objection protects an intended constraint, and which merely reflects the current implementation?

## Development and agent work

- Which external dependencies are required for local development, and why?
- What may an agent change on its own, and what requires explicit approval?
