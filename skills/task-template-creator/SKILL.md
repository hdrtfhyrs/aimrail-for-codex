---
name: task-template-creator
description: Local host and workflow additions for task-template-creator; use with the corresponding official upstream skill.
---

# Local adaptations for task-template-creator

These are the local additions and replacement instructions extracted from the installed upstream skill. Use the upstream skill from its official host distribution for unchanged instructions and third-party runtime files. The repository MIT licence applies to local additions only. Follow current user and host instructions when they override a historical rule. See [source and installation notes](UPSTREAM.md).

   - Google Workspace: load the `task-google-drive` execution guide and the matching `task-google-docs`, `task-google-slides`, or `task-google-sheets` guide. Use the native [@Google Drive](plugin://google-drive@openai-curated-remote) connector to inspect the native artifact, and use the file bridge below. Then:

After verification, return the appropriate supported artifact-template card and concise instructions for finding and using the template. Adapt prose to the user’s language and include any material limitation or unfinished item. Do not hide gaps merely to match a fixed response template.

- Preserve the card directive schema and exact returned identifiers. Adapt explanatory wording and language to the user, without making unsupported claims about Gallery availability.

- In the how to find template section, use the matching native Gallery entry: `@Documents`, `@Presentations`, `@Spreadsheets`, `@Google Drive` for all three Google Workspace template kinds, `$imagegen`, or `@Product Design`. For image templates, use the generated template's exact `galleryKind`; never treat ImageGen and Product Design as interchangeable. Preserve the literal `@` or `$` so Codex renders an unquoted mention. These are UI Gallery entry points, not execution-skill routing: use the applicable task-* guide for the authoring workflow, and do not claim a personal task-* skill mention opens the native Gallery.
