# Source provenance and public scope

[English home](../../README.md) · [中文](../source-and-scope.md)

This repository was extracted and organized from the author's personal AI work system. It publishes the overall working philosophy, reusable core, author-owned general plugins, skills, and support modules. Public files were assembled in a separate directory with general configuration. Private production directories and historical data are not uploaded.

| Files | Treatment |
| --- | --- |
| `shared-state.mjs`, `knowledge-lifecycle.mjs` | Extracted from the implementation in use; preserve Markdown source records, concurrent updates, archiving, and knowledge retirement logic. |
| `project-context.mjs`, `knowledge.mjs`, `knowledge-record.mjs`, `recall.mjs`, `deliverables.mjs` | Extracted from the implementation in use; personal paths, caches, and registration locations become workspace configuration; host-specific project directories become a file-directory adapter. |
| `paths.mjs`, `registry-store.mjs`, `project-registry.mjs`, `object-access.mjs`, `resources.mjs`, `bin/ai-work.mjs` | Public-edition adapters providing general paths, empty registries, versioned persistence, and command entry points. |
| `templates/`, `examples/` | General working principles, blank project structure, and fictional examples; English counterparts are in [i18n/en/templates](../../i18n/en/templates/) and [i18n/en/examples](../../i18n/en/examples/). |
| `plugins/`, `modules/search-integrations/` | Search and community integration source in use; preserve multi-source discovery, source reading, and source expansion logic; personal accounts, data, and installed dependencies are excluded. |
| `skills/`, `integrations/` | Author-owned skills, host hooks, roles, and general continuation templates; dedicated documentation describes provenance and host requirements. English instruction copies are in [i18n/en/skills](../../i18n/en/skills/) and [i18n/en/integrations](../../i18n/en/integrations/). |
| `modules/system/`, `tools/` | General information, collaboration, object/resource, execution, storage, and presentation implementations; dedicated documentation maps files to modules. |

This edition does not copy personal knowledge content, original conversations, account records, historical caches, or specific business data. It excludes fiction/training/paid creative-production pipelines, Xianyu managed operations/orders/key sales, dedicated sales, and commercial product-production pipelines. General information collection, execution, and storage remain; users provide their own data and services.

Installed third-party copies, commercial host programs, official runtimes, and model weights are not bundled. Adapter code is handled according to provenance, with author-owned changes and upstream licenses explained separately. See [Third-party notices](../../THIRD_PARTY_NOTICES.md) for dependency declarations. Module READMEs and dedicated documents describe actual source scope and dependencies.

Retrieval uses public methods such as Chinese tokenization, SQLite FTS5, embeddings, and RRF. Their presence does not claim authorship of these algorithms. Original-document reading and vector services come from runtimes and optional services, with their own licenses retained.

The core and related modules come from implementations used in the author's environment. This public edition includes path adaptations and new entry points; that does not establish effectiveness for every host, operating system, or task. Public claims distinguish source, configuration, actual invocation, and continuous operation. Resolve problems in actual use with targeted fixes guided by the relevant source records.

The English edition shares the source and interfaces with the Chinese edition. Required Chinese directory names, filenames, and persistent protocol fields remain unchanged. English documentation and instructions do not claim a fully translated runtime or UI, nor a new end-to-end run of the complete public system. Official third-party skills remain local amendments rather than complete upstream packages relicensed under MIT.
