# Organize explanations with diagrams and connected prose

## Organize relationships according to the diagram's purpose

First identify the main question the diagram answers, then choose nodes, connections, and reading order. A process diagram lets the reader follow actions from input to output; a responsibility diagram shows who owns what and delivers what to whom; a comparison diagram shows differences for the same objects and dimensions. Drawing every item and connecting every node does not prove these relationships are clear. Place key conditions and gaps beside relevant actions/connections, and develop causes and adoption reasons in connected prose.

When a process involves several owners, place owners in swimlane headings or short step annotations. Mark storage locations beside the relevant step when needed. Neither becomes an extra sequential step. If multiple relationship types must share one diagram, use distinguishable regions, line styles, and labels. If complexity obscures the main line, split it into connected diagrams, tables, or prose. Choose layout according to actual width and relationships. Feedback loops express only real return conditions or influences, not a vague “continuous improvement” loop.

A sustained state is not an instantaneous action. For example, an illustrative shared-device main line is “receive reservation → wait until the device is free → assign a use period → current user uses the device → end condition is reached → inspect the device and release the period,” then return to the next reservation. Other people asking when it will become free is a consultation during current use. Placing it inside that state or in prose clarifies when it happens. A separate branch must explicitly show the trigger “consultation received during use”; merely saying “notify expected end later” leaves the relationship unclear. This example explains organization of sustained states and loops. Determine actual entry points and end conditions from the current task.

For example, to explain how external material enters work, show “find sources → obtain and save originals → research adoption → project adopts → actual outcome.” A “knowledge branch” is a responsibility name, an “original library” is a storage location, and “returning experience to storage” is a reuse relationship. Mentioning them in prose does not justify placing them in the same sequential chain. If knowledge maintenance and project execution have a real handoff, show it separately in a responsibility table or a connection labeled with the delivered content. Keep node wording concrete: “research adoption” tells the reader the action; “add category, object, causality” requires explaining what it changes in the current task.

## Connect diagrams and prose

The following is an illustrative rewrite for generic document collaboration, not an actual runtime result.

Original excerpt, translated for this English example:

> A candidate explanatory document already exists, while the automatic-generation entry point still has unfinished parts.

Assuming the existing material describes responsibilities and results for four parts, show “source material → AI assistant assigns four parts → executors write drafts → AI assistant selects and supplements → document candidate.” Mark the second part's divergence at the draft step. Show “page button automatically calls the model” below the process as still unconnected. Short labels in the diagram must not change responsibilities, quantities, or completion status.

Then write:

> The candidate explanatory document has been written and can be read directly. The AI assistant assigned four parts, executors wrote drafts, and the assistant selected, corrected, and supplemented them. The second part diverged from the task and was not adopted. The assistant's replacement writing produced the complete candidate. You can read this document now, but the page button still cannot automatically call the model.

This paragraph explains the same subject through “what was obtained → how it was made → what went wrong → what can be used now.” A rewrite cannot present one candidate as formally adopted or treat a process diagram as evidence of program automation. The candidate and failure here illustrate faithful expression only.

## Sources and adaptation

Author originals were read on 2026-10-04. Baoyu's [infographics](https://github.com/JimLiu/baoyu-skills/tree/main/skills/baoyu-infographic) choose content relationships separately from visual style; [article illustrations](https://github.com/JimLiu/baoyu-skills/tree/main/skills/baoyu-article-illustrator) first establish where a diagram belongs and what it helps explain; [diagrams](https://github.com/JimLiu/baoyu-skills/tree/main/skills/baoyu-diagram) provide relationship, process, and hierarchical-layout methods using actual SVG. Adopt these organization methods. Use editable text and connections for accurate relationship diagrams, and current image generation when a drawn or stylized bitmap is needed.

The 2026-09-23 revision of Chinese [op7418/Humanizer-zh](https://github.com/op7418/Humanizer-zh) emphasizes preserving facts and connective relationships. [ai-zixun/humanizer-zh](https://github.com/ai-zixun/humanizer-zh) checks paragraph purpose along the whole article's main line. Adopt faithful rewriting and whole-document coherence checks, without fixed banned words, punctuation prohibitions, or unrequested author imitation.

[visual-explainer](https://github.com/nicobailon/visual-explainer/tree/main/plugins/visual-explainer) emphasizes diagrams on the first screen and one clear question per diagram. Adopt that reading order. Decide whether to create a webpage, the diagram count, length, and format according to the current outcome and user requirements, without importing fixed gates such as “chart every number.”
