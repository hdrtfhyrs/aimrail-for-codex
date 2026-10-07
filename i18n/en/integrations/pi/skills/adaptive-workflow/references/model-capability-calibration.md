# Subagent capability calibration (2026-09-25)

Read as needed to choose models, reasoning effort, or diagnose a stalled executor. This historical selection reference is not a scoring router, fixed pipeline, or permission configuration. Model capability and session responsibility are separate; runtime determines roles, and model names cannot change hierarchy.

## Capability boundaries and layered construction

This is the user's historical work-distribution choice, not a measured universal model-capability ceiling. Assess suitability using task unknowns, coupling, and execution behavior. One file can demand difficult global judgment. More agents or Max reasoning does not guarantee resolving a problem beyond one executor's capability.

Each layer personally implements core work suited to it and delegates simpler pieces during development. Astra handles overall and hardest parts; Sol handles the next level of core work for its module while Luna directly implements clear functions, components, adapters, data processing, or local repairs. Luna is not limited to evidence/reports, and Sol is not merely a dispatcher. Reduce key unknowns before delegation while retaining local autonomy; do not send unsettled architecture plus implementation, verification, and integration wholesale to a leaf.

## Actual assignment

- Inspect `agent_models` for exact currently available and authorized `provider:id`, distinguishing versions such as GPT-5.6 and GPT-6. The settings below are user-selected historical defaults, not an inference about other models by name. Prefer explicit reasoning effort. For exact `openai-codex` IDs `gpt-6-luna`, `gpt-6-sol`, and `gpt-6-astra`, the then-active `routeTask` uses `max`, `high`, and `medium` respectively for `auto`/omitted effort. Other versions/providers retain their original behavior. This is not score-based or automatic best-model selection.
- **Luna is a specialized executor with judgment.** Assign clearly bounded, independently checkable packages for complete implementation, research, debugging, refactoring, or writing, allowing autonomous cause diagnosis and method choice. Line-by-line commands are unnecessary. **GPT-6 Luna defaults directly to Max** under the user's chosen reasoning investment, without starting High and upgrading, or lowering effort because it is a descendant or the task is routine. Override only for user instructions or specific task limits. Lower price does not justify assigning highly ambiguous critical architecture wholesale.
- **Sol coordinates and performs complex execution. GPT-6 Sol defaults to High, with Max for difficult problems.** High covers complex planning, cross-module implementation, and hard debugging. Consider Max directly when a specific difficulty stalls or failure is costly, without requiring xhigh first. Sol must not only delegate, nor give all key judgments to Luna just because Luna can execute.
- **Astra handles overall understanding, key tradeoffs, and complex delivery, beyond final review. GPT-6 Astra defaults to Medium** for important proposals, cross-domain constraints, and key checking. Adjust explicitly for harder analysis as needed instead of using Max universally. This does not authorize Astra delegation in a prohibited layer; coordinator/review tasks still follow runtime model and role permissions.
- These are user-selected default combinations, not mandatory steps or a requirement to use every role. Choose an appropriate configuration directly for known difficulties. Higher effort is not guaranteed to improve every task. A Luna Max result close to Sol on one measure does not establish general equivalence.

## Rework and escalation

Distinguish missing material, undefined interfaces, local omissions, and capability mismatch first. Supplement information when that resolves the issue. Repeated misunderstanding of the same relationship, structural errors, or a difficulty failing to converge calls for the parent to solve the hard part or split the task again, rather than simply returning the original package and urging progress. Retain usable artifacts while independent work continues. Return specific unresolved Sol problems to the coordinator. Changing effort does not establish that mismatch is resolved. This guide does not change the existing routes or depth mechanism.

Judge primarily by complete usable deliverables, also considering omissions, rework, duration, and actual consumption. Token price or one leaderboard should not decide everything. Reuse existing task acceptance evidence rather than adding mandatory model comparison runs. `fast_mode:off` is separate from reasoning effort.

## Evidence and limits

The original historical note recorded reading relevant passages from these pages; this English translation has not independently reverified them:

- [Official selection](https://learn.chatgpt.com/docs/model-selection): Luna for bounded tasks, Sol for everyday work requiring judgment, Astra for ambiguous problems and complex delivery, with comparison on actual tasks recommended.
- [Independent evaluation, 2026-09-22](https://artificialanalysis.ai/articles/gpt-6-sol-and-luna-push-the-cost-efficiency-frontier): cost improvements do not establish universal capability gains; some knowledge-work deliverables have omissions, and Luna's coding-agent index declined from its predecessor.
- [Author analysis, 2026-09-23](https://note.com/wing_tech/n/n9faf1893bef0): task-dependent tradeoffs of GPT-6 Luna High/Max; the author stated that this chiefly analyzed public leaderboards rather than direct work comparisons.
- [Older-version reference](https://christiant.io/gpt-5-6-value-analysis/): GPT-5.6 general and coding upgrade paths differ; do not transfer its values to GPT-6.

These authors often reuse official or the same evaluation data; article count does not establish independence. A user image without a full model version is not fixed-version performance evidence. This was behavior/selection calibration, not model training, and did not prove improved local-task success rates. Judge actual effects from later real deliveries.
