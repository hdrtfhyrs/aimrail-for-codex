---
name: task-google-docs
description: Local host and workflow additions for task-google-docs; use with the corresponding official upstream skill.
---

# Local adaptations for task-google-docs

These are the local additions and replacement instructions extracted from the installed upstream skill. Use the upstream skill from its official host distribution for unchanged instructions and third-party runtime files. The repository MIT licence applies to local additions only. Follow current user and host instructions when they override a historical rule. See [source and installation notes](UPSTREAM.md).

Ask only when an unresolved detail would materially change the requested result and cannot be inferred from the prompt, prior answers, or sources. Do not ask because the artifact is new or a major rewrite. If the result is clear, proceed. Ask at most one focused clarification batch, continue independent work, and use a disclosed reasonable assumption for optional unanswered details. A timeout is not authorization for an action that actually requires permission.

3. **Polished or layout-sensitive net-new creation without a constraining Google Doc template/reference:** use `[@documents](plugin://documents@openai-primary-runtime)` with the `google_docs_default` preset (when this plugin is unavailable, use the direct connector route and apply styling through the current Docs API), then read `references/reference-import-docx-to-native-docs.md` and import as native Google Docs. A supplied Google Doc template/reference disqualifies this route even when the requested result is polished; a content-only source does not. After import, replace mandatory chip-eligible values with native chips during post-import normalization.

Read the relevant references when their information is needed, and reuse still-current guidance across turns. Do not bulk-read the folder. Before writing, resolve the active schema and the task-specific preservation requirements.
