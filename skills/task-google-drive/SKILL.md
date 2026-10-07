---
name: task-google-drive
description: Local host and workflow additions for task-google-drive; use with the corresponding official upstream skill.
---

# Local adaptations for task-google-drive

These are the local additions and replacement instructions extracted from the installed upstream skill. Use the upstream skill from its official host distribution for unchanged instructions and third-party runtime files. The repository MIT licence applies to local additions only. Follow current user and host instructions when they override a historical rule. See [source and installation notes](UPSTREAM.md).

- Drive, Docs, Sheets, or Slides comment creation, comment replies, comment resolution, or review-by-comments: use [google-drive-comments](../task-drive-comments/SKILL.md).
- Google Docs net-new creation, content summary, revision planning, prose rewriting, or section edits: use [google-docs](../task-google-docs/SKILL.md).
- Google Sheets creation, local spreadsheet import, range inspection, table cleanup, data restructuring, formula design or repair, chart creation or repair, or batch updates: use [google-sheets](../task-google-sheets/SKILL.md).
- Google Slides deck summary, content edits, new deck creation, local presentation import, visual cleanup, structural repair, or template migration: use [google-slides](../task-google-slides/SKILL.md).

- If the user asks to create a new Google Doc, route to the Docs skill and follow its current native-create, native-template-copy, or eligible DOCX-import route. Do not impose a local DOCX import from this router.

- If the user asks to create a new Google Sheet, route to the Sheets skill. Choose direct native creation, native template copy, or local XLSX import according to the requested result, required native features, and available tools.

- If the user asks to create a new Google Slides deck, follow the current Slides/Presentations route. Reuse a required native template; otherwise choose supported native creation or PPTX import that best preserves the requested content and editability. Do not impose mandatory local PPTX import from this router.

- Comments: [google-drive-comments](../task-drive-comments/SKILL.md)
- Docs: [google-docs](../task-google-docs/SKILL.md)
- Sheets: [google-sheets](../task-google-sheets/SKILL.md)
- Slides: [google-slides](../task-google-slides/SKILL.md)
