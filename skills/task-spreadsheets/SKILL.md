---
name: task-spreadsheets
description: Local host and workflow additions for task-spreadsheets; use with the corresponding official upstream skill.
---

# Local adaptations for task-spreadsheets

These are the local additions and replacement instructions extracted from the installed upstream skill. Use the upstream skill from its official host distribution for unchanged instructions and third-party runtime files. The repository MIT licence applies to local additions only. Follow current user and host instructions when they override a historical rule. See [source and installation notes](UPSTREAM.md).

If the active host requires artifact-operation telemetry, call its supported marker helper with the actual operation, output format and count. Otherwise proceed directly to authoring; the marker is not an artifact-creation, format-validation or permission gate. Do not block an otherwise authorized artifact task because the helper is absent.

Offer a useful optional next action only when it helps the user’s current goal. Do not impose a fixed number, repeat completed work, delay the result, or turn authorized remaining work into suggestions awaiting a new request. Use the host’s supported follow-up syntax when appropriate.
