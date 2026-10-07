# Aimrail for Codex

**Persistent projects, grounded research and coordinated execution for Codex.**

Aimrail extends Codex with project continuity, source-based research, knowledge recall, skills and reusable tool integrations. Goals, evidence and deliverables stay in readable files, so work can continue across conversations, context compaction and executor handoffs.

Codex supplies the model and tools. Aimrail supplies the task records, research methods, shared knowledge and integration points. The core is a Node.js CLI; the repository also includes Claude and Pi adapters.

**English** · [简体中文](README.zh-CN.md)

[Quickstart](docs/en/quickstart.md) · [Search & MCP](docs/en/search-plugins.md) · [Host integration](docs/en/skills-and-hosts.md) · [Documentation](#documentation)

[MIT](LICENSE) · Node.js 24+ · [Releases](https://github.com/hdrtfhyrs/aimrail-for-codex/releases) · [Issues](https://github.com/hdrtfhyrs/aimrail-for-codex/issues)

## Why Aimrail

Long-running work needs more than a conversation history. The objective changes, sources accumulate, decisions need context, and another session may need to finish what was started.

Aimrail keeps the project objective, complete current task, applicable conditions, progress and artifacts as distinct records. The AI reads those records alongside new instructions, researches missing information and saves the result for the next step.

## Capabilities

| Capability | What it adds |
|---|---|
| **Project continuity** | Project and branch records, explicit session binding, context reconciliation and handoff files. Goals and criteria remain separate from progress. |
| **Source-based research** | Chinese and English search, GitHub/npm/MCP discovery, durable candidates, pagination, original-source reading and link expansion. |
| **Knowledge and experience recall** | Local full-text search, optional semantic retrieval, combined ranking, original-source references and recoverable knowledge retirement. |
| **Objects and resources** | Record responsibilities, conditions, sources, tools and account entitlements, with observed capability separate from declared availability. |
| **Collaboration and execution** | Task windows, ownership, handoffs, locked state updates, event queues, executor leases, checkpoints and retries. |
| **Information pipelines** | Source collection, analysis queues, cloud-batch reception and saved continuation records. |
| **Artifacts and storage** | Deliverable registration, full-text/web presentation, storage adapters, snapshots and scoped archiving. |

The [implementation guide](docs/en/mechanisms.md) explains state locking, source coverage, hybrid recall and execution recovery with links to the code.

## Quickstart

The file-backed core requires **Node.js 24 or later**. Run from the repository root:

```powershell
git clone https://github.com/hdrtfhyrs/aimrail-for-codex.git
cd aimrail-for-codex

node bin/ai-work.mjs init --workspace ./workspace --language en
node bin/ai-work.mjs project init --workspace ./workspace --language en --name "Source Organizer" --goal "Organize material by topic and retain traceable sources"
node bin/ai-work.mjs projects --workspace ./workspace
```

This creates a workspace and project records. Ask Codex to read `workspace/AGENTS.md` and the project's goal and task files. Follow the [complete quickstart](docs/en/quickstart.md) to update task state, recall knowledge and produce a handoff.

Use `--language zh-CN` for Chinese instructions. Both editions share the same runtime and persisted protocols.

## Add capabilities

Start with the core, then configure the modules needed for your work.

| Component | Source | Setup |
|---|---|---|
| Project, state and knowledge core | [src](src/) · [CLI](bin/ai-work.mjs) | [Quickstart](docs/en/quickstart.md) |
| Search MCP and community-tool wrappers | [plugins](plugins/) · [source readers](modules/search-integrations/) | [Search configuration](docs/en/search-plugins.md) |
| Skills, hooks, roles and host adapters | [skills](skills/) · [integrations](integrations/) | [Host integration](docs/en/skills-and-hosts.md) |
| Information, collaboration and runtime modules | [modules/system](modules/system/) | [System configuration](docs/en/general-system.md) |
| English skills and task templates | [i18n/en](i18n/en/) | [Language guide](docs/en/languages.md) |

Models, external services, browser access and continuing runtime use the environment you configure. Each guide describes its dependencies and entry points.

## Documentation

| Guide | Contents |
|---|---|
| [Quickstart](docs/en/quickstart.md) | Initialize a project, update a task, recall records and hand off work |
| [Search and MCP](docs/en/search-plugins.md) | Search providers, community tools, source reading and MCP configuration |
| [Skills and host integration](docs/en/skills-and-hosts.md) | Codex/Claude/Pi adapters, hooks, authored skills and role templates |
| [System modules](docs/en/general-system.md) | Information collection, objects, collaboration, runtime, storage and presentation |
| [Architecture](docs/en/architecture.md) | File layout, module responsibilities and integration relationships |
| [Implementation mechanisms](docs/en/mechanisms.md) | State updates, source coverage, hybrid recall and execution recovery |
| [Design principles](docs/en/philosophy.md) | Goals, evidence, judgment, persistence and collaboration |
| [Languages](docs/en/languages.md) | English materials and compatible protocol names |
| [Source and scope](docs/en/source-and-scope.md) | Public implementations, extracted modules and excluded private data |

## FAQ

<details>
<summary>How does this connect to Codex?</summary>

The project and knowledge core runs through the CLI. Authored skills describe research, collaboration and continuation methods. Host hooks read relevant project records at configured events. Register the appropriate interfaces in your host using the [integration guide](docs/en/skills-and-hosts.md).

</details>

<details>
<summary>Can I use just the search plugin or another module?</summary>

Yes. Search tools, source readers, authored skills and the file-backed core have their own entry points. Choose a module from [Add capabilities](#add-capabilities) and configure its documented dependencies.

</details>

<details>
<summary>How are English instructions and private data handled?</summary>

English guides, skills and templates are included. Some persisted filenames, state keys and runtime output remain Chinese for compatibility. User-created records and configuration belong in the ignored workspace. The public repository provides blank configuration and fictional examples.

</details>

## Contributing

Bug reports, practical use cases, documentation fixes, source adapters and host integrations are welcome. English and Chinese are both welcome. Use the [issue forms](https://github.com/hdrtfhyrs/aimrail-for-codex/issues/new/choose) or read the [contribution guide](docs/en/contributing.md) before submitting a change.

See the [changelog](CHANGELOG.md) and [releases](https://github.com/hdrtfhyrs/aimrail-for-codex/releases) for published updates.

## License

Authored code and documentation use the [MIT License](LICENSE). Third-party dependencies and upstream skills retain their own licenses; local skill adaptations publish the author's additions. See [third-party notices](THIRD_PARTY_NOTICES.md) for the boundaries.
