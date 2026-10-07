---
name: task-google-sheets
description: Local host and workflow additions for task-google-sheets; use with the corresponding official upstream skill.
---

# Local adaptations for task-google-sheets

These are the local additions and replacement instructions extracted from the installed upstream skill. Use the upstream skill from its official host distribution for unchanged instructions and third-party runtime files. The repository MIT licence applies to local additions only. Follow current user and host instructions when they override a historical rule. See [source and installation notes](UPSTREAM.md).

Ask only when an unresolved detail would materially change the requested result and cannot be inferred from the prompt, prior answers, or sources. Do not ask because the artifact is new or a major rewrite. If the result is clear, proceed. Ask at most one focused clarification batch, continue independent work, and use a disclosed reasonable assumption for optional unanswered details. A timeout is not authorization for an action that actually requires permission.

Read the task-specific API and preservation references needed for the actual operation; reuse relevant guidance already read and still current. Keep latency proportional to the task.

2. Other new Google Sheets creation: Inspect the available skills and plugins for the registered `task-spreadsheets` capability. It may be exposed as the `$task-spreadsheets` skill, the `@Spreadsheets` plugin, or the plugin URI `plugin://spreadsheets@openai-primary-runtime`. If found, load and follow its instructions.
   - Use local XLSX import when local authoring materially improves the requested workbook or when the user requests import. For simple native creation, use Google Sheets MCP directly. Native template/reference following remains on the copy-and-adapt route. Add native table DROPDOWN columns only where requested or required by the source.

If Default Routing uses the system spreadsheet plugin or skill like `[@spreadsheets](plugin://spreadsheets@openai-primary-runtime)` or `$task-spreadsheets`:

5. If uncertain, inspect the reference index and read only the files that resolve the concrete uncertainty. Reuse current relevant guidance; do not reread it merely because a new turn started. Before editing, ground the actual request shape and preservation requirements.

For existing-sheet edits, edit the identified spreadsheet in place and return its observed Google Sheets link. For creation, return the verified native Google Sheets link after the selected create/copy/import route succeeds. Include a requested local workbook as well; otherwise keep staging files out of the final answer.
