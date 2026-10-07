# Quick start

[English home](../../README.md) · [中文](../quickstart.md)

Use Node.js 24 or later and run the commands below from the repository root. They do not install persistent services, plugins, or startup/login triggers.

## Create a workspace and project

```powershell
node bin/ai-work.mjs init --workspace ./workspace --language en
node bin/ai-work.mjs project init --workspace ./workspace --language en --name "Source Organizer" --goal "Build a tool that organizes materials by topic and preserves their sources"
node bin/ai-work.mjs projects --workspace ./workspace
```

You can also point `--workspace` at any explicit external directory. Existing workspace files are preserved. If a project with the same name already has source records, initialization refuses to overwrite them. `--language en` selects English instruction templates; omit it to retain the Chinese entry point. Both languages use the same source code and interfaces.

Project names, goals, and ordinary content can be English. Required storage names such as `核心.md`, `共享状态.md`, `项目概况.md`, and `成果/` remain Chinese for compatibility. The persisted shared-state headings and fields likewise retain the existing protocol, with English explanations in the templates. This language option does not translate all runtime messages or the host UI.

## Save a complete task

First have the AI adapt the task JSON to the actual assignment. `i18n/en/examples/task-update.json` is a fictional structural example:

```powershell
$projectDir = (Resolve-Path "./workspace/projects/Source Organizer").Path
$taskFile = (Resolve-Path "./i18n/en/examples/task-update.json").Path
node bin/ai-work.mjs state update --workspace ./workspace --project $projectDir --input $taskFile
node bin/ai-work.mjs context read --workspace ./workspace --project $projectDir --branch source-organizer
```

In a Linux/macOS terminal, replace those two parameters with the corresponding absolute paths. The state interface accepts Chinese fields and the aliases `goal`, `criteria`, `phase`, `owner`, `done`, `next`, `conditions`, `ledger`, and `evidence`. For subsequent updates, omit `create:true` and supply only changed fields.

After the user adds detail or corrects something, the AI connects the new message to the original project and updates the affected goal, conditions, and criteria. For progress-only reports, update `done`, `next`, and the phase.

## Knowledge and source reading

Put your own Markdown materials in the workspace's `memory/knowledge/`, `memory/experiences/`, and `memory/errors/`, or explicitly register other sources in `knowledge-sources.json`.

```powershell
node bin/ai-work.mjs knowledge overview --workspace ./workspace
node bin/ai-work.mjs knowledge catalog --json --workspace ./workspace
node bin/ai-work.mjs knowledge search --query "continue the same project in a new conversation" --json --workspace ./workspace
node bin/ai-work.mjs recall search --query "continue the same project in a new conversation" --no-vector --json --workspace ./workspace
```

Continue from a returned ID or source reference with `knowledge read --ref ... --json`. For paginated source reading, follow `nextCursor` until the requested range reports `complete:true`. An excerpt does not establish that the entire material has been read.

Vector retrieval is optional. After starting Ollama yourself and preparing an embedding model, run `recall index --embed`. The default model name is `bge-m3`; change it with `RECALL_EMBED_MODEL`. The command does not automatically start the service or download a model.

## Objects and resources

```powershell
node bin/ai-work.mjs objects list --workspace ./workspace
node bin/ai-work.mjs objects save --input ./examples/object.json --expected-version 0 --workspace ./workspace
node bin/ai-work.mjs objects read --id local-text-index --workspace ./workspace
node bin/ai-work.mjs resources list --kind resources --workspace ./workspace
```

The example object is not a real resource. Pass the current `version` when updating an existing object. Resource updates use the same `--input` and `--expected-version` options, with an explicit `--kind`.

These commands use the independent core's object and resource registries. The full system's object/resource services use different record locations and schemas; see [Skills and host integration](skills-and-hosts.md) before selecting a full-system entry point.

## Deliverables and handoff

Put actual outputs under the project's `成果/` directory. Use `deliverables --help` to see the registration JSON format and commands, then register the actual result.

```powershell
node bin/ai-work.mjs deliverables --help --workspace ./workspace
node bin/ai-work.mjs handoff --workspace ./workspace --project $projectDir --branch source-organizer --out ./workspace/handoffs/source-organizer.md
```

Handoff creates a new file and does not overwrite an existing one. The recipient reads it, then follows references into source code, materials, and deliverables. Subsequent state changes still return to the project's source records.

## What to look for during use

Look at whether the AI preserves the complete goal, applies materials appropriately, finds another route when blocked, and returns actual deliverables. Initialization, retrieval, and state persistence provide a basis for work; they do not prove that understanding or a business task is complete. Resolve actual errors using the specific invocation and relevant source records.

This starts the reusable core. For search plugins, follow [Search and source continuation](search-plugins.md); for the broader information, execution, storage, and presentation modules, follow [General system source and entry points](general-system.md). Their external accounts, dependencies, and persistent operation require your own configuration.
