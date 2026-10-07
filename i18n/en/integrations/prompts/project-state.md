# Project association, current tasks, and continuity

This guide covers project files, bindings, state updates, and continuation. Read it when associating a new conversation with a project, switching branches, or missing continuation material. Common behavior follows [AGENTS.md](../AGENTS.md); compaction follows [compact.md](compact.md).

Run every command below from the repository root. English instructions use the same root source code. Chinese filenames, persisted field names, and structural headings remain part of the compatibility protocol.

## What each project file holds

Keep long-term, recurring work with an intended final result in `workspace/projects/<project-name>/`. One-off questions can remain unbound.

| File | Contents and update timing |
|---|---|
| `核心.md` | The full currently confirmed purpose, long-term scope, and success criteria. When long-term intent changes, rewrite in place by meaning, merge duplication, and replace corrected content. Keep original statements and prior changes in source records. |
| `项目概况.md` | Relationships among project branches and current material entry points. The core goal and shared state remain authoritative for overall purpose and common conditions; do not duplicate them here. Update when branches are added or retired. |
| Relevant branch in `共享状态.md` | Full task goal, completion criteria, effective conditions, stage, progress, owner, and evidence. Update that branch when state changes. |
| `主线/<full_session_id>.md` | Location, details, and earlier evidence for the shared branch. Maintain the current task here when there is no shared state. |
| `进展.md` | Actual decisions, achievements, failures, continuation results, and necessary rework feedback. Write "not observed" for effects that have not been observed. |
| `成果/` | Usable artifacts, necessary originals, and maintenance instructions. Register saved results in the existing artifact catalog. |

Conditions and routes that affect only this task belong in its branch. Read history, original statements, experience, and artifacts for supporting evidence. Directories and parent tasks locate material; the user's assignment and target branch define current responsibility. Keep necessary recovery originals before modifying an old core-goal file.

## Associate the project and target branch

The shared entry point is [project-context.mjs](../../../../integrations/context/project-context.mjs).

```sh
node "integrations/context/project-context.mjs" read --project "ABS_PROJECT" --branch STABLE_BRANCH_ID --compact
node "integrations/context/project-context.mjs" read --project "ABS_PROJECT" --ledger "ABS_TASK_LEDGER" --compact
node "integrations/context/project-context.mjs" bind --host codex --session FULL_SESSION_ID --cwd "ABS_WORKDIR" --project "ABS_PROJECT" --branch STABLE_BRANCH_ID
```

Supported hosts are `codex`, `claude`, `antigravity`, and `shared`; `--json` returns structured location data. `read` is read-only; `bind` saves ownership. Use `rebind` on an existing binding only when the user explicitly switches or corrects ownership. Specify the stable ID when a ledger has multiple branches. Codex and Claude use their actual full session IDs.

On the first association, obtain the core goal, overall relationships, and the effective state of this task. Read progress and related originals when continuing old decisions or when the goal remains unclear. Use an existing complete effective task directly; supplement only missing material or material that changes the next action. Ask the user only when remaining ambiguity in ownership would change the result.

A hook's session ledger is a locator. For cross-project or cross-branch work, or a new executor, explicitly supply the target project, branch/ledger, and file ownership. Parent bindings and shared-directory pointers remain sources; this assignment determines the target binding.

## Maintain current state only in the relevant branch

Write the goal and completion criteria fully from cumulative user statements; record progress separately. Use `[ ]` in criteria for unmet results and `[x]` for results supported by actual artifacts. Progress changes affect only completed work and next steps. When the user changes the goal or scope, update the goal, criteria, conditions, and evidence together. Latest corrections take priority; save them and notify affected executors before the affected action.

Read and update through the interface that merges changes under a lock:

```sh
node "integrations/context/shared-state.mjs" read --project "ABS_PROJECT" --branch STABLE_ID
node "integrations/context/shared-state.mjs" update --project "ABS_PROJECT" --input "ABS_UPDATE_JSON"
```

The update JSON contains `id` and `changes`; provide only changed fields. Persisted fields include `阶段` (stage), `负责人` (owner), `已做` (done), `下一步` (next), `有效条件` (conditions), `主线` (ledger), `依据` (evidence), `本轮目标` (goal), and `完成标准` (criteria). `goal` and `criteria` alias the last two. The English input aliases shown in [task-update.json](../../examples/task-update.json) are accepted by the same interface. Creation also requires `create:true`, `name`, and the original seven state fields; include `goal`/`criteria` to define the result and scope. For example:

```json
{"id":"stable-branch-id","changes":{"goal":"Full current result and scope","criteria":["[ ] Unmet result","[x] Result supported by an artifact"]}}
```

Keep `无` as the no-ledger sentinel, or supply a valid absolute Markdown path; translating this protocol value to "none" changes its meaning to the program. Keep the filenames `核心.md`, `共享状态.md`, `项目概况.md`, and `进展.md`, the revision comment, and the shared-state headings `## 共同条件`, `## 当前分支`, and `## 已完成里程碑`. Prose around these can be English.

On first creation, establish facts from the core goal, progress, related ledgers, and artifacts. Keep original locations for historical milestones. At completion, update only criteria supported by actual outputs and retain unmet items.

For a multi-turn task without shared state, use four sections in an independent ledger:

```md
# 当前分支
Project/branch location, ultimate-goal entry point, full current goal and completion criteria.
# 有效状态
User-confirmed conditions, key conclusions, gaps, and sources; distinguish original statements, measurements, and AI judgments.
# 阶段
Research / execution and authorized scope / complete / paused.
# 接续
Existing artifacts, key originals, specific blockers, and next steps.
```

## Archive a completed branch

A branch may move to `共享状态归档/` when its result is delivered and no actual current work remains, or when continuation is explicitly assigned to a new branch. Retain branches with outstanding work, external results being awaited, or active execution. Archives keep the full original text and unverified boundaries. Leave a stable-ID index entry under `已归档分支` in shared state; archiving does not complete unverified items.

```sh
node "integrations/context/shared-state.mjs" archive --project "ABS_PROJECT" --input "ABS_ARCHIVE_JSON"
```

JSON is `{ids:["branch-id"],expectedRevision:CURRENT_REVISION}`. Read the current original and select exact IDs first. Reread on a revision change; protect parallel edits. Old bindings, `read`, and `map expand` still read archived text by stable ID. Updating that ID restores the complete branch to current branches under the lock and merges the changes without changing old chat bindings. Archived history is excluded from candidates for unbound tasks but remains discoverable through the shared-state index and map.

## Save artifacts and archive chats

Project and artifact files carry long-term work; the chat is the current workbench. If the user has authorized archiving after results are saved, old chats need not stay in the sidebar for continuity.

At the end of a task, save and register usable results and necessary originals, then update the branch's actual outcome, effective conditions, unmet items, and next steps. Apply the user's archive authorization only to the specified finished work whose results are saved. Retain outstanding tasks, active work, and chats still being used. A successor reads the core goal, branch, and artifact entry first; consult historical conversations only for missing sources or important changes in direction. Archiving retains chat history and does not complete a branch or delete artifacts, original data, or running programs.

When asked to organize existing chats, obtain actual chats, their branches, and saved artifacts within the user's specified scope. Handle confirmed finished items and apply this request's scope to chats awaiting continuation. Preserve the purpose of chats in use, active execution, and chats explicitly retained. Idle state or the end of one turn does not establish task completion. One artifact file does not authorize archiving every unfinished task.

Use the current host's official archive interface and retain actual IDs, original titles, project/branch, and artifact entry points for recovery and discovery. Codex uses `set_thread_archived`; restore using the same ID with archiving disabled. For a batch, save scope and continuation entries first, then record each actual outcome. Keep failures pending; a file record does not prove that the UI chat was archived.

## Replace executors and migrate old ledgers

Hand over the complete goal, criteria, conditions, authorization, artifacts, unmet items, and accessible originals so the recipient can continue from files. Delegation and fresh-executor calls follow `outcome-collaboration`. Save state before handing over write responsibility. The previous writer exits that part while other active authorizations continue.

When migrating old ledgers or dated files, verify that the complete `session_id` marker in the body matches the current conversation and consult the original conversation's effective conditions. If this cannot be established, retain the old path pending clarification; history and provenance stay where they were.

## Merge original statements into current conditions

The current AI interprets ordinary additions in the complete task context and updates the same conditions once settled. Use an independent organizing AI when needed for complex corrections, cross-chat consolidation, or handoff. Programs preserve statements and versions; the owner integrates candidates into the relevant branch.

The historical instructions refer to `modules/system/任务协作/context-manager/README.md`; that workspace guide is not shipped here. The shared public [context-manager implementation](../../../../modules/system/任务协作/context-manager/context-manager.mjs) defines the module entry and candidate format.

```sh
node "modules/system/运行中心/system.mjs" context prepare --project "ABS_PROJECT" --branch STABLE_ID --messages "ABS_STATEMENTS_JSON" --job-dir "ABS_NEW_JOB_DIR"
node "modules/system/运行中心/system.mjs" context apply --job "ABS_JOB_DIR/job.json" --candidate "ABS_JOB_DIR/candidate.json"
node "modules/system/运行中心/system.mjs" context context --project "ABS_PROJECT" --branch STABLE_ID --out "ABS_CONTINUATION.md"
```

`prepare` produces `prompt.md`, `input.json`, and `candidate-template.json`. Write `candidate.json` from these materials and then run `apply`. Before the first apply, `prepare` and `context` share the source directory; afterwards use the branch's archive pointer. If a changed baseline rejects the old job, prepare again. Maintain goal/criteria changes separately through shared state.

`context` includes the full current branch and unmerged statements; `--messages` persistently ingests new messages. Hook ingestion covers only explicitly bound branches with a first-apply marker. Adjacent questions and answers supply reference context; user statements and assistant explanations are distinct sources. Preserve missing sources and ambiguity explicitly.

In `contextPlan`, `active` means integrated into `conditions`, `reference` retains provenance, and `open` retains unresolved discussion and necessary context. Assign material according to whether omission changes understanding or the next action. Carry unresolved discussion forward. Consult the public implementation or your installation's module README for full arguments and concurrency details.

## Deliver actual artifacts

Use the delivery rules in `AGENTS.md`. Save artifacts in the project's `成果/`; inspect `成果/INDEX.md` before registering:

```sh
node "integrations/context/deliverables.mjs" --help
node "integrations/context/deliverables.mjs" register --project "ABS_PROJECT" --input "ABS_REGISTRATION_JSON"
```

Registration JSON uses `directory`, `entry`, `title`, `summary`, `status`, `boundary`, `next`, `branch`, `ledger`, and `evidence`; `save` also supports `files` for copying specified deliverables. Locate records using `search`/`read`; the overview entry is `workspace/projects/成果总览.md`.

Open registered artifacts or intermediate outputs through the existing showcase:

```sh
node "modules/system/成果展厅/showcase.mjs" open --ref REGISTERED_ID
node "modules/system/成果展厅/showcase.mjs" open --file "ABS_ARTIFACT"
```

Use `url` to obtain an address for a browser panel. The original guide refers to a local `成果/2026-10-03_成果展厅/使用说明.md` for `展示.json` and `workspace/memory/knowledge/从实际软件学习开发.md` for software-learning material. Those user-maintained workspace documents are not shipped here; use the public module's [showcase source](../../../../modules/system/成果展厅/showcase.mjs) and your own project documentation rather than claiming they are installed.

## Tools as needed

- Local environment and cross-host conversations: `node "integrations/context/workspace.mjs" help`; operations follow [共同声明.md](../../../../modules/system/本地统一/共同声明.md).
- Knowledge and corrections: your workspace's `workspace/memory/knowledge/INDEX.md` and `workspace/memory/errors/WRITING.md`.
- Precise cleanup: [system-maintenance.mjs](../../../../integrations/context/system-maintenance.mjs).
- Browser and HTML preview: `task-computer-use`. For a single file, run `node "tools/local-html-preview.mjs" start --file "ABS_HTML"`; after edits, stop and start again. Multi-file applications use the project's development server.
