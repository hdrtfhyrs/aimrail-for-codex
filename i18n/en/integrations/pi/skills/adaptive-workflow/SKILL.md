---
name: adaptive-workflow
description: Organize evidence gathering, challenge, decisions, and parallel execution as needed for delegation, key judgments, or exceptional coordination.
---

# Workflow as needed

This historical Pi skill handles complex collaboration and key judgments. Global AGENTS supplies general goal, evidence, and authorization principles. Roles and skills supply methods without expanding actual tools, data access, or write permissions. Current user conditions and host rules take precedence; see the [Pi guide](../../README.md).

## Understand the goal before acting

Align with the continuing overall goal, then interpret new requirements in context. A local correction does not automatically replace the overall direction; explicit goal changes follow the latest user requirement. Retrieve relevant original statements, later corrections, mature implementations, and applicable error categories. Identify the explicit user goal, your interpretation, and unverified assumptions. Compare evidence and counterexamples for different directions when a significant new proposal has key unknowns; do not search only for support of the existing plan. Investigate both user-proposed methods and assistant plans without confusing methods with goals. Neither follow blindly nor replace user choice with AI judgment. For new facts, read [adaptive-research](../adaptive-research/SKILL.md) rather than duplicating its methods here.

Before implementing a change affecting routes or important tradeoffs, explain its concrete mechanism, operation, deliverable, expected effect, cost/limits, and unverified premises so the user can judge and adjust. Continue when authorization is clear without per-step approvals. Clarify only key ambiguity that changes the route.

## Layered execution and complete delivery

Every layer produces actual artifacts. The coordinator usually owns overall design and the hardest implementation; Sol owns the next level of core design and implementation for modules; Luna directly completes simple implementations or information deliverables with clear goals and interfaces. Follow the user's hierarchy and model settings. Assign work by actual judgment difficulty, not file counts, task titles, or the word "core". A core function may contain much simple code that can be delegated; neither hoard the whole module nor hand it wholesale to a leaf agent.

Upper layers work on their own core while delegating clear pieces in parallel, without waiting for every detail to be planned. Lower layers must not merely read and report for upper layers to implement again. Keep unresolved cross-module relationships and key route choices with a layer able to handle them. Reduce those unknowns in lower-layer packages while allowing autonomous local detail. More reasoning effort or more agents does not guarantee that one executor's capability limit is overcome.

A brief contains the goal, necessary evidence, actual deliverables, and interface connections. The content/implementation owner writes directly into target files; upper layers check key interfaces and integrate, while summaries support handoff. Background tasks overlap upper/lower work. Tests and reviews depending on unsettled implementation wait until behavior/interfaces are clear; simultaneous starts do not establish independent parallelism. Avoid tasks invented for headcount, repeated full context, and repetitive status reports.

Supplement missing information. When an executor repeatedly misunderstands a relationship, makes structural errors, or stalls on an undefined interface, the upper layer should decide, take over the difficulty, or narrow the package instead of only urging progress and lengthening instructions. Return specific problems beyond Sol's capability to the coordinator, retain completed artifacts, and continue independent work. Do not add fixed retry counts or approval gates.

For models and reasoning settings, read the capability-calibration reference as needed. Kimi K3 uses `kimi-coding:k3-256k`; MiMo 2.6 Pro uses `xiaomi-token-plan-cn:mimo-v2.6-pro`. In the established discussion process, they may contribute independent opinions as needed, limited to discussion and evidence reading rather than construction or underlying execution. The coordinator checks their opinions rather than voting by majority. Do not call them on every task or replace established primary discussion arrangements. Actual routes, hierarchy, and concurrency follow the current runtime and explicit round requirements; temporary numbers do not become a permanent partitioning algorithm.

## Challenge and exceptions

Important new proposals, high-impact changes, key unknowns, or substantive disagreements should receive independent challenge based on evidence. Peer discussion questions goal understanding, evidence, and the proposal. Lower-layer construction produces assets within clear goals/interfaces. Keep these responsibilities distinct. Supply relevant originals and matching error categories to peer challengers without prescribing conclusions. The coordinator reads reports, addresses key opinions, and implements accepted changes in the proposal or artifacts. "Discussion completed" does not establish action. See [control-loop.md](references/control-loop.md) for methods and formal binding.

Continue small implementations within an established route. Return to the relevant judgment only when new evidence would overturn its basis or change the route, instead of repeating the full process or adding approval. Recover locally reversible failures within scope while unaffected independent work continues. Escalate out-of-scope, cross-module, route-changing, or major-risk issues with evidence, effects, attempted routes, and decisions needed. Verify established new errors against relevant existing categories, deduplicate, and retain sources/applicability under current write rules. Do not store unverified inferences as facts.

Read only as needed:

- [control-loop.md](references/control-loop.md): evidence, challenge, decision, and binding.
- [model-capability-calibration.md](references/model-capability-calibration.md): model selection difficulty or blocked execution.
- [understanding-delivery.md](references/understanding-delivery.md): unfamiliar domains, important tradeoffs, or deeper user understanding.
