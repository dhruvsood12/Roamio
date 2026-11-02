# FlightBrain Autonomous Build Orchestrator

Single-prompt, zero-further-input driver. The orchestrator thinks and routes;
everything else is a capability it reaches for. Push every decision to the
cheapest layer that can own it (verification → CLIs, real facts → MCP/API,
procedure → skills, parallel work → subagents, must-happen → hooks).

## The goal
The whole loop drives toward `harness/GOAL.md` — a finished, working product for a
traveler who flies every ~2 weeks. "Done" = every acceptance item there demonstrated
by green deterministic gates, stopping only at the human-gated boundaries GOAL lists.

## Ground rules
- A cycle is DONE only when `bash harness/gates.sh` exits 0. Agents agreeing is
  NOT done. Tests/typecheck/diff-check decide.
- Obey `AGENTS.md` (operating contract + definition of done) on every change.
- Never invent prices/schedules/availability/provider semantics. Preserve
  provenance. Unknown stays unknown (see `docs/CURRENT_STATE.md`).
- Human-gated actions: external/live API calls, authorized keys, `~/.codex/config.toml`,
  anything irreversible/outward-facing beyond this repo. `git push` and GitHub PR
  create/merge for this repo are AUTHORIZED for this session by the user.
- Persist state in git + `docs/CURRENT_STATE.md` so context summarization can't
  lose progress.

## Auto-correct (self-healing on every red gate)
When `gates.sh` (fast or full) is red, do NOT escalate to the human — recover:
1. Capture the exact failing test/typecheck/diff output.
2. Classify: (a) implementation bug, (b) over-strict/incorrect test, (c) missing
   allowlist/export wiring, (d) real contract defect surfaced by a reviewer.
3. Route the specific failure back to the implementer subagent with the captured
   output and the classification; it fixes the narrowest thing and re-runs the gate.
4. Re-run the FULL gate (not just --fast — the import-isolation test only runs full).
5. Bounded retries: up to 3 implementer round-trips per slice. If still red after 3,
   stop and surface the failure with the output — a genuine block, not a silent skip.
Never weaken a gate to make it pass. A test may only change if a reviewer adjudicates
it wrong, with the reason recorded in the commit.

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
