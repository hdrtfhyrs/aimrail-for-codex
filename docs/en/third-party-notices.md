# Sources, dependencies and licenses

[English home](../../README.md) · [中文原件](../../THIRD_PARTY_NOTICES.md)

The repository MIT license applies to authored implementations and documentation. Dependency packages, external tools, host products and original source materials continue to use their own licenses. Calling a third-party tool does not relicense its implementation under this repository's MIT license.

| Area | Source and treatment |
|---|---|
| Project, knowledge, task continuity and general system code | Extracted from the author's reusable modules; paths, navigation and configuration adapted to the public layout |
| Search and source reading | Authored code is published; MCP SDK, Readability, Cheerio, jsdom, node-fetch and others are installed through npm; see the [versioned dependency list](../../plugins/search-tools/THIRD-PARTY.md) |
| Community-tool wrappers | Authored wrappers are published; Context7, OpenCLI and Bilibili tools retain their own licenses; see [dependency versions and original license texts](../../plugins/community-tools/THIRD-PARTY.md) |
| Skills, roles and hooks | Authored instructions and adaptations are published; [skills and host integration](skills-and-hosts.md) distinguishes local additions from official skills and runtimes |
| General npm/Python dependencies | See [system modules](general-system.md) and the respective package/requirements files; installed dependency implementations are not bundled |

The community tools depend on `bilibili-api-python`, which uses GPL-3.0-or-later. OpenCLI and bilibili-cli use Apache-2.0; Context7 uses MIT. Their original license texts are retained with the community-tool notices. The root MIT license does not override these licenses; follow the upstream license for the corresponding version when installing or redistributing it.

Commercial AI hosts, account connectors, browser bridges, model weights and official plugin installation trees are not bundled. Users obtain these from the corresponding product or package manager and supply their own access and configuration. Service quotas, network conditions and service terms remain the provider's responsibility.

Use of general methods such as search, SQLite FTS5, embeddings, RRF, source discovery and file handoffs is not an originality claim over those methods. Cited research materials remain the original authors' work. The public extraction does not include private research records, conversations or account data.

The English edition translates the project's own instructions and local adaptations. Third-party license texts are retained in their original form.
