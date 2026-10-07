---
name: task-visualize
description: Local host and workflow additions for task-visualize; use with the corresponding official upstream skill.
---

# Local adaptations for task-visualize

These are the local additions and replacement instructions extracted from the installed upstream skill. Use the upstream skill from its official host distribution for unchanged instructions and third-party runtime files. The repository MIT licence applies to local additions only. Follow current user and host instructions when they override a historical rule. See [source and installation notes](UPSTREAM.md).

Communicate under the active conversation rules: explain material progress or blockers briefly when needed. Keep implementation details out of the visualization itself unless requested, and focus the final prose on what it helps the user understand.

Before choosing a renderer or layout for an explanatory diagram, use the diagram guidance in [plain-writing](../plain-writing/SKILL.md). Its relationship organization and labeling guidance is maintained there; read its linked visual-reading reference when a diagram combines processes, responsibilities, or feedback. Choose the visual from the actual information relationship; use plots for measured change. Rendering and interaction follow this skill's implementation guidance below.

Show real outputs or observed screenshots when explaining a completed task; label schematic and historical examples accurately. Follow an overview with the actual result when available. Keep causes and conditions in coherent surrounding prose rather than repeating every label. Visuals for a saved document belong in that document or its companion assets; the inline HTML contract below applies to conversation fragments. Substantive Chinese prose follows the current plain-writing skill.
