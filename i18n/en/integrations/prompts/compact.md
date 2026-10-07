# Compaction and continuation handoff

From the available context, provide enough state to continue the current task. Mark missing information as "unknown". Compaction does not require tool calls. Preserve the latest corrections and the original wording that changes scope, authorization, or stage.

Include:

- Location: absolute project path, full session ID, stable branch ID, task ledger, and core-goal original. State explicitly when there is no project.
- Task: full current goal and scope, its relationship to the overall purpose and relevant branches, and every completion criterion still unmet.
- Conditions: user-confirmed conditions, latest corrections, key conclusions, and unresolved gaps. Distinguish original statements, measurements, and judgments, with sources. Remove obsolete items from current state.
- Stage: research, execution and authorized scope, completion, or pause. Existing authorization continues; corrections replace only conflicting actions.
- Continuation: existing artifacts and originals, actual level of completion, unmet items, specific blockers, and next steps. For active collaboration, add dependencies, file ownership, reporting recipient, and actions affected by corrections.

Keep current state in the relevant shared branch and provide its path and branch ID in the handoff. When there is no shared state, maintain an independent task ledger according to [project-state.md](project-state.md). If a complete effective task already exists, continue directly and supply only missing originals or those that would change the next action.
