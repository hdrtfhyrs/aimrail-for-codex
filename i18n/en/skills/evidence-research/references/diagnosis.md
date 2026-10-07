# Object identification and cause diagnosis

Purpose: find the cause and fix that change the current method. A user-reported symptom is an entry point. The cause may be upstream or in output itself; evidence determines its location. Emergency recovery may proceed first while retaining necessary evidence; root-cause work must not hold up a currently usable result.

## Understand the object before judging the action

Establish what the user expects, what the specific object is, its responsibility in this task, the inputs it actually accepts, and its operating conditions. Read originals about purpose, training task, version, interface, and restrictions to the extent they affect judgment; do not infer capability from a name or parameter count. Search experience and mature practice by object, operation, and conditions, translating applicable experience into evidence to inspect now.

## Find deviations along the actual process

Use existing code, configuration, inputs/outputs, call records, or source material to reconstruct enough of the process to explain the phenomenon. Inspect where data is acquired, filtered, transformed, and saved, and how control flow selects conditions, loops, updates state, and retries. Choose what matters for the actual system rather than listing every check each time. Compare the intended responsibility/method with actual execution to find where the deviation enters and how it reaches the result. Several output issues may share an upstream cause; do not mechanically split them into independent failures. When a task reuses source material, inspect how its specific content becomes input; retaining labels alone does not count as reuse.

## Advance with evidence that distinguishes causes

Choose supported explanations that would change the fix. Where ambiguous, state what different evidence each explanation predicts, then inspect key state, add necessary observation, or make a minimal comparison. In an experiment, change only the factor you are trying to distinguish where possible, rather than arbitrarily changing material, parameters, and task together. Failure does not automatically establish insufficient capability, and fixing one sample does not establish a single cause. Fix confirmed causes directly and revise judgment when contrary evidence appears.

Report the action causing the deviation, evidence, impact, and fix first, followed by necessary resulting symptoms. When evidence is insufficient, retain “not yet located” and provide the next operation that distinguishes causes; do not invent a root cause or an unsupported possibility list. Subsequent real tasks establish whether long-term capability improved, rather than saved rules, case reading, or the same model's reflection.

## Applicable examples

- A material-generation model goes off topic: first inspect its current responsibility and actual input. Determine whether it was assigned complex-rule understanding, adaptation of source events, and plot design simultaneously. If the intended method was to adapt existing events before generation, check whether the coordinator actually replaced it with a self-written scene. Short input is a way to reduce task complexity, not a universal length prohibition for all small models.
- Program output omits items: trace filtering conditions, loop range, pagination termination, state updates, and final writes. If data is missing before writing, fix the stage causing the omission. If intermediate results are complete, continue into the output stage. Do not respond to omissions by merely adding supplemental output or assume a loop is wrong without evidence.

Method sources: Google SRE's [Effective Troubleshooting](https://sre.google/sre-book/effective-troubleshooting/) on understanding systems, testing hypotheses, and inspecting component boundaries; Brendan Gregg's [Performance Analysis Methodology](https://www.brendangregg.com/methodology.html) on the failure modes of tool-driven diagnosis and random changes; Alibaba Cloud's [Attribution analysis](https://www.alibabacloud.com/help/zh/cms/cloudmonitor-2-0/attribution-analysis) on differences not directly proving root causes. These methods are adapted to the current AI workflow; these sources do not establish diagnostic gains in this system.
