---
name: task-page-writing
description: Local host and workflow additions for task-page-writing; use with the corresponding official upstream skill.
---

# Local adaptations for task-page-writing

These are the local additions and replacement instructions extracted from the installed upstream skill. Use the upstream skill from its official host distribution for unchanged instructions and third-party runtime files. The repository MIT licence applies to local additions only. Follow current user and host instructions when they override a historical rule. See [source and installation notes](UPSTREAM.md).

name: task-page-writing
description: Create or edit Page or Space content when the user has selected that destination. Ordinary chat prose, local documents and repository Markdown do not trigger this Page workflow.

Use a clear descriptive Page title and meaningful headings. Preserve requested titles, established names, useful punctuation, and status labels. Native Page titles and headings are preferred; decorative lines are optional only when requested or useful.

- Check factual dates, numbers, and scope against the relevant source passage before stating them. Keep event dates distinct from publication or update dates and dates attached to nearby items. Use search snippets to find sources, not to settle a claim when the full source is available. Preserve source limits and label assumptions or unresolved gaps.
- Respect the user's limits on what each source may support. A reliable benchmark still cannot supply an input the request excludes. Where permitted evidence is missing, use an explicitly labeled assumption or state the gap; do not hide the substitution in a calculation.
- Distinguish sourced facts from your own inferences where they appear, including table cells and bullets. A citation supports only what its source establishes, not nearby claims about causes, roles, or behavior. Label material hypotheses and proposed choices locally; a general assumptions section does not qualify unrelated claims.

Use `replacements`, not `patches`. `expected_hash` is required even with `base_sequence`. Include surrounding text when a short phrase repeats.

If the host exposes `patch_page` instead, use its `observed_sequence`, `changes`, and `replacements`. Its `block_index` is the canonical read index, not a filtered-list position. Do not mix tool schemas.

Read the [Page content catalog](references/page-content.md) for new Pages, substantial layout changes, or capability questions. It contains native syntax, metadata shapes, and authoring limits. Resolve the link relative to this `SKILL.md`; small wording edits need no catalog read.

Preserve unrelated content and comments. Handle failures by cause:

- Unknown commit outcome: read back before retrying to avoid duplicates.
- Mixed results: retain confirmed successes and retry only unresolved work.

If the corrected request is rejected or unsupported, diagnose the stated cause and use an available authorized operation or alternative that preserves the requested result. Stop only the blocked action; complete independent work and report any remaining gap.

An applied receipt confirms a commit. Read back new Pages, broad rewrites, and preservation-sensitive edits to check the title, content, and structure; avoid redundant full-Page reads after small confirmed patches. When a preview is available, inspect new Pages and layout changes for clear hierarchy, readable tables, clipping, and loaded media. Fix issues within scope and check again. Otherwise state what remains unverified: saved Markdown alone does not prove that the layout, image, or embed rendered correctly.
