# Start Here

## First Codex prompt

Read `AGENTS.md`, `docs/MASTER_PLAN.md`, `docs/ARCHITECTURE.md`, `docs/PRODUCT_SPEC.md`, and `docs/CODEX_TASKS.md` completely before modifying anything.

Then execute **C001 only**.

Requirements:
- Review the existing canonical schemas for correctness and missing invariants.
- Strengthen date/time, airport, money, passenger and cabin validation where appropriate.
- Add tests for valid and invalid objects.
- Do not add a real provider.
- Do not build UI.
- Do not change the architecture.
- Do not invent provider semantics.
- End by reporting files changed, tests added, known gaps, and the exact next task identifier. Do not begin the next task.

## Astra architecture-review prompt

Read the repository as a principal travel-platform architect. Use `docs/LLM_COUNCIL_PROMPT.md` to adversarially review the current architecture. Focus on invariants and failure modes, not cosmetic refactors. Return proposed changes as a prioritized patch plan; do not implement changes until each proposal can be tied to a concrete failure mode and test.
