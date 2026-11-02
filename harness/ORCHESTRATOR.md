# FlightBrain Autonomous Build Orchestrator

Single-prompt, zero-further-input driver. The orchestrator thinks and routes;
everything else is a capability it reaches for. Push every decision to the
cheapest layer that can own it (verification → CLIs, real facts → MCP/API,
procedure → skills, parallel work → subagents, must-happen → hooks).

## Ground rules
- A cycle is DONE only when `bash harness/gates.sh` exits 0. Agents agreeing is
  NOT done. Tests/typecheck/diff-check decide.
- Obey `AGENTS.md` (operating contract + definition of done) on every change.
- Never invent prices/schedules/availability/provider semantics. Preserve
  provenance. Unknown stays unknown (see `docs/CURRENT_STATE.md`).
- Human-gated actions (never auto): `git push`, external/live API calls,
  anything irreversible or outward-facing. Commit locally on green is allowed.
- Persist state in git + `docs/CURRENT_STATE.md` so context summarization can't
  lose progress.

## The loop (self-paced via /loop, or manual per turn)
1. Pick the next unfinished task from `docs/CODEX_TASKS.md` (respect ordering;
   skip BLOCKED items, e.g. C002.3b-M).
2. REVIEW-FIRST if there is uncommitted work: run a review cycle on the existing
   diff before writing new code.
3. IMPLEMENT: spawn 1 implementer subagent (cheap model) with `agents/implementer.md`
   + the task spec. It edits code + tests, runs `harness/gates.sh --fast`.
4. REVIEW (council): spawn 2 reviewer subagents on DIFFERENT models
   (e.g. opus + haiku) with `agents/reviewer.md`. They argue against the diff.
5. RECONCILE: orchestrator merges findings, dedupes, discards non-issues with a
   reason, and sends real findings back to the implementer. Repeat 3–5 until
   reviewers raise no blocking findings.
6. GATE: run `bash harness/gates.sh` (full). Red → back to step 3 with the failure.
7. COMMIT on green (one concern per commit). Update `docs/CURRENT_STATE.md`.
8. Advance to the next task. Stop only when the queue is done, a human-gated
   action is required, or the loop is genuinely blocked.

## Cost discipline
- Implementer: cheap model. Reviewers: capable models, but scope them to the DIFF.
- Council only on risky/contract-touching changes; trivial changes skip to gates.
- Keep subagent tool-output out of orchestrator context — only conclusions return.
