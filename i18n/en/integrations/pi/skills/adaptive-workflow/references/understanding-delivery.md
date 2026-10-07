# Deliver explanations that help the user judge

Load as needed alongside [SKILL.md](../SKILL.md) and [control-loop.md](control-loop.md). This defines user-facing explanatory delivery without changing evidence gathering, scheduling, agent counts, permissions, or runtime workflow.

## When to use it

When the user wants to learn, or a task involves unfamiliar domains or important tradeoffs, help them understand the problem while completing the task. Simple status updates and routine small repairs need only the result. Match depth to task value rather than imposing a fixed template or four-part format on every response.

## What to explain

Use concise natural prose for what actually matters to this result:

- The core issue and, where needed, principles or a conceptual framework for understanding it.
- Mature feasible routes and key tradeoffs, limited to choices that affect the decision rather than exhaustive lists.
- Why this route was selected and which goal and constraints it serves.
- Which conclusions were verified and within what scope; which are judgments, inferences, or unverified, with important boundaries and remaining uncertainty.

The user may request deeper explanation, moving from intuitive concepts into mechanisms, evidence, or practice. Mention that possibility naturally if useful without asking at every ending or promising rapid expertise. Help the user form their own judgment rather than replacing it.

## Evidence and collaboration

Trace relevant original sources when explanations need support and state the actual reading/verification scope. Do not present summaries, search hits, or agent reports as personal verification. Distinguish verifiable facts, model analysis, and unverified items without turning guesses into facts or hiding counterexamples and important conflicts. Simple tasks need no invented research or citations.

Workers return checkable facts, source locations, actual verification, and unresolved boundaries to their parent. The integrating coordinator produces the final user-facing explanation. Do not require each worker to teach the whole topic or treat a local report as the overall conclusion.
