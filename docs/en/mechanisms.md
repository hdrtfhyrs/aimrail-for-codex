# Implementation mechanisms

[English home](../../README.md) · [中文](../mechanisms.md)

The project, research, recall and execution mechanisms below link directly to their implementations.


## Task state: progress does not overwrite the objective

Markdown is the task record, and a stable branch ID identifies the work. A state update acquires a file lock, rereads the current version, merges only the supplied fields, and saves through a temporary file and atomic replacement. Goals, criteria, conditions, completed work and next actions have distinct fields. Archived branches remain readable by their original IDs.

This lets “where the work is now” change independently of “what the work must accomplish,” with explicit records for session changes, context compaction and executor handoffs. [State implementation](../../src/shared-state.mjs) · [Continuity mechanisms](../../docs/en/integration.md)

## Research: a discovered lead can be followed to its source

Search stores the candidates actually returned by providers and their pagination progress. Display budgets limit the returned window; later calls can continue reading. Source extraction preserves the final URL, date provenance, coverage and fetch status. Forum originals, replies, video descriptions, comments and subtitles have separate reading paths. Restricted or dynamic sources can produce host-reading requests and accept the source text the host actually retrieved.

The tools and research skill support discovery, initial interpretation, deeper reading, revised understanding and continued execution. The model chooses the queries and decides how to use the evidence. [Search guide](../../docs/en/search-plugins.md) · [English research skill](../../i18n/en/skills/evidence-research/SKILL.md)

## Recall: lexical ranking, semantic candidates and original records

FTS5 trigram supplies local lexical search, with optional embeddings for semantic candidates. Reciprocal Rank Fusion combines the two rankings. The implementation uses `k = 60`:

```text
RRF(d) = Σᵢ 1 / (60 + rankᵢ(d))
```

Results retain source references, locations and further-reading entry points. Similarity helps locate material; the active AI still checks whether its conditions apply. Invalid knowledge can be retired while its recovery material is retained. [Full-system recall](../../integrations/context/recall.mjs) · [Files and indexes](../../docs/en/architecture.md)

## Execution: state is more specific than “running”

Event dispatch uses a persistent queue and stable event keys. Executors acquire expiring leases. Result writes validate the lease, preventing an expired executor from overwriting a newer result. Failures enter retry, capability-waiting or terminal states; checkpoints and artifact references travel with the job. Handoffs carry the complete objective, conditions, evidence and outstanding work.

The reusable implementation provides these mechanisms; the user configures the models, accounts and continuing runtime. [Dispatch implementation](../../modules/system/运行中心/event-dispatch.mjs) · [Task handoffs](../../modules/system/任务协作/handoff-files.mjs)
