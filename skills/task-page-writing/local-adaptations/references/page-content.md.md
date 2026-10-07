# Local additions to references/page-content.md

Install the unchanged upstream file at its normal location. The following are the local inserted or replaced portions; they retain the source order.

Use supported Markdown operations, never raw Yjs. In hosted edits, `block_units` is ordered: each string is parsed independently; each `{kind, markdown, metadata?}` object is one canonical block. Keep tables, callouts, and fences complete. Preserve `metadata.stream_kind`: omitted means `content`; `scratch` is a separate stream.

Markdown replacement retains the first block's metadata and merges supplied top-level keys. Do not copy geometry/anchors onto unrelated replacement blocks. Prefer guarded text patches around existing images; verify structural rewrites. Preserve unknown metadata and never replace complete stored state with a model-visible projection.

- **Agent Instructions:** use `agent_instructions` for requested durable guidance; a heading with that name is ordinary text. Writing instructions alone does not prove maintenance is scheduled or active; report reconciliation/approval status accurately.
