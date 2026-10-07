# How files and modules work together

[English home](../../README.md) · [中文](../architecture.md)

Every entry point reads the source records from the same workspace. Set its location with `AI_WORK_HOME` or the core commands' `--workspace` option; the default is `workspace/` under the repository root. Source directories contain code. The workspace contains your configuration, data, credential state, and outputs.

```text
workspace/
├── AGENTS.md                    Current working principles
├── projects.json                Project directory and explicitly attached projects
├── knowledge-sources.json       Explicitly registered knowledge sources
├── knowledge-retirements.json   Retired knowledge status; history remains recoverable
├── objects.json                 Objects, categories, and concepts
├── resources.json               Account references, entitlements, tools, and source declarations
├── projects/
│   └── PROJECT_NAME/
│       ├── 核心.md              Long-term purpose and applicable scope
│       ├── 共享状态.md          Current complete tasks and progress
│       ├── 项目概况.md          Relationships between branches
│       ├── 进展.md              Actual decisions and results
│       ├── 主线/                Necessary sources and detailed continuation records
│       ├── 成果/                Actual outputs and the deliverable index
│       └── 共享状态归档/        Historical tasks retrieved by stable ID
├── memory/
│   ├── knowledge/
│   ├── experiences/
│   └── errors/
├── bindings/                    Explicit host/session pointers to projects
├── handoffs/                    Explicitly generated handoff files
├── history/                     Recovery copies from before declaration changes
└── .cache/                      Rebuildable indexes
```

The Chinese filenames and directories shown above are part of the shared implementation's storage contract. Keep them unchanged when using English instructions and project content. The persisted headings and fields in `共享状态.md` likewise remain compatible with the original protocol; the English templates explain their meanings without introducing a separate schema.

## From assignment to continuation

The AI interprets the current task using its source records and saves a stable branch through `state update`. Within a file lock, `shared-state.mjs` rereads the latest state, merges only the supplied fields, and saves through a temporary file and atomic replacement. It does not infer user intent. Ordinary progress updates do not overwrite the goal or completion criteria.

`context read` retrieves the project core, branch relationships, current conditions, and deliverable entry points. If an explicitly requested branch does not exist, it preserves the location error rather than selecting another branch. `context bind` points a real host session to an explicit project; use `rebind` to change an existing assignment. `handoff` saves the same context in a new handoff file.

This version does not automatically operate the host UI. A host's existing file-reading or hook capabilities can provide automatic message injection, using the same source records.

## Knowledge, recall, and applicability

`knowledge.mjs` reads Markdown sources registered in `knowledge-sources.json`. It provides complete cards, a catalog, Chinese-language search, and paginated continuation. File changes rebuild the cache. `knowledge-lifecycle.mjs` records retirement and restoration status while retaining the original files; retired entries leave ordinary recall results.

`recall.mjs` reuses these materials to build a SQLite FTS5 trigram index, with optional Ollama embedding indexes and RRF ranking fusion. It returns source references and candidate excerpts. Ranking indicates retrieval similarity; it does not establish applicability to the current task.

The recall module retains optional readers for the original system's information database and failure inbox. The public edition contains none of their production data and does not actively collect it. Knowledge cards, objects, resources, tasks, and deliverables are sufficient for the default local index.

## Declarations and deliverables

Object records describe categories, responsibilities, conditions, sources, facts, judgments, and unknowns. Resource declarations describe purpose and actual usage conditions. Records are versioned: read the current version before updating. Conflicts reject an overwrite, and previous records enter the recovery directory. The host's credential tools hold passwords, tokens, Cookies, and similar secrets.

Deliverable registration references actual project outputs and records summaries, status, limitations, and next steps. A registration file's existence, a status declaration, and a business process actually running continuously are distinct facts. Determine the specific result from its source records.

## Search, skills, and host modules

`plugins/` contains general search, MCP-compatible entry points, and community tool wrappers. `modules/search-integrations/` contains GitHub, forum, and Bilibili source readers. Search candidates and source text are stored in the workspace, while the model selects the actual queries. Research skills connect source discovery, source retrieval, and adoption to the current task.

The shared source materials are in `skills/` and `integrations/`; their English instruction counterparts are in [i18n/en/skills](../../i18n/en/skills/) and [i18n/en/integrations](../../i18n/en/integrations/). Skills describe working methods. Integrations contain hooks, roles, and host templates. Once explicitly registered in the host, hooks retrieve the same task and materials. The repository does not automatically write templates into your host configuration. You provide third-party host capabilities and account connections.

`modules/system/` retains the source directories for general information, objects, collaboration, execution, archiving, and presentation modules. Code and user state have separate locations; see [General system source and entry points](general-system.md) for configuration. Use these modules according to the task and its dependencies. A general capability does not automatically authorize or start a specific business operation.
