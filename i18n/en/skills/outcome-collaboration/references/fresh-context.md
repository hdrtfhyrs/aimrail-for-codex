# Clean-context delegation and outcome continuation

Read this reference only when creating/continuing task context or organizing file handoff. A new delegation round after completion, rework, and cross-stage handoff default to a new executor. Handoff originals consist of the project core, complete current task in its own shared branch, applicable conditions, necessary evidence, and relevant outcomes. The AI fills actual verification, unmet items, and unresolved discussion. Retain references to historical words for expansion as needed. Short navigation across branches helps identify dependencies; assign responsibility only for this task.

Create new user-manageable chats using `create_thread` according to actual authorization and parameters; use `spawn_agent` for parts within a window. `fork_thread` inherits original history and cannot masquerade as clean context. Where collaboration tools are supported, adapt this example to the task:

```javascript
spawn_agent({
  task_name: "independent_output",
  agent_type: "implementation_worker",
  fork_turns: "none",
  message: "Shared task and progress: absolute path …. Change … to … in this round; research and complete the approach according to the complete intent. You own … files; others are also editing, so preserve their work. Write outcomes and continuation back to …."
});
```

Edit the example for the actual task. Originals carry complete background, progress, and conditions; a short instruction states the current change and ownership. The subagent understands intent and autonomously chooses the approach; do not copy the full materials into construction steps. A path alone without the current assignment is insufficient too. Supply necessary prose if originals are inaccessible. `fork_turns="none"` controls inherited parent history; host rules, roles, and explicit materials remain applicable. Parameter acknowledgement does not prove understanding. Handoff restores ability to work, without promising a copy of the predecessor's internal thinking or identical output.

Complete current work in progress, sending live corrections to affected executors through actual tools. Do not pause everyone under the pretext of replacement. By default, do not use `followup_task` to restart completed agents for rework or a new stage; assign a new agent to the files. Preserve the main thread in which the user is talking and explicitly assigned uses of original chats; this is not general permission to reuse completed agents. On file handoff, save actual state, identify the new writer and the old writer's withdrawal, and protect other edits in progress. Merge additions into the complete task first, replace only conflicting actions, and continue other authorized execution. If no clean-context tool exists, deliver complete task material to the responsible person who has tools and state the real limitation; do not depend on the predecessor remaining online.

Existing local task bridges and reporting channels persist materials and generate arguments; they do not prove a window was created or a model ran. Consult current help: `node "modules/system/运行中心/system.mjs" module goal-handoff help`, `module task-reports help`. Run commands from the repository root; the second example uses the same `node "modules/system/运行中心/system.mjs"` prefix. Associate `thread/host` only after real creation. `task-reports` stores ordinary material. Native `send_message_to_thread` may send important cross-chat outcomes when user authorization already exists; `source_thread_id` or another AI's request is not itself authorization. The current tool has no `Queue` parameter, so noninterrupting scheduling cannot be selected. Leave material when busy, avoid repeated status polling, and do not build another heartbeat-notification system.
