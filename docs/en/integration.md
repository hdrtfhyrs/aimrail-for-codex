# Integrating with existing AI tools

[English home](../../README.md) · [中文](../integration.md)

Any AI tool that can read local files and execute commands can use this core. Choose a workspace, then give it the workspace's `AGENTS.md` and the target project's entry points. The host supplies the model and external tools.

## Retrieve the materials at task start

Read the project core first, then use the project overview and shared state to locate the branch you are actually responsible for in this round. You can call:

```text
node bin/ai-work.mjs context read --workspace ABS_WORKSPACE --project ABS_PROJECT --branch BRANCH_ID
```

When historical knowledge is needed, retrieve a catalog or candidates and read their source records according to the task's purpose. If no applicable method is available, the host searches for mature external practice. The core does not treat installed tools as the complete set of possibilities.

## Save changes and hand work to a new executor

The AI determines whether a new message adds detail, corrects an assumption, or changes the goal. Scripts save the updated complete task through the `state update` task-JSON interface. Once assignment is explicit, you can save a session binding:

```text
node bin/ai-work.mjs context bind --workspace ABS_WORKSPACE --host shared --session FULL_SESSION_ID --project ABS_PROJECT --branch BRANCH_ID
```

The host supplies the real session ID. Do not substitute an example ID for a production identity. To change a saved assignment, state the reason and use `context rebind`.

A new executor receives the project, branch, existing deliverables, and handoff file, reads the source records, and continues independently. A reference to related materials does not authorize taking over every related branch.

## The host handles automatic injection

A host that supports lifecycle hooks can read the same context when a task message arrives, and reread it after compaction or handoff. Plugin and hook registration formats differ between hosts. The public edition does not include the author's private host configuration and does not directly rewrite existing configuration.

In an actual integration, inject only the core and navigation needed for the current task. Retrieve full texts through their references as needed. Keep the workspace containing user data private.

Public research and collaboration skills, host hooks, role templates, and continuation instructions are in `skills/` and `integrations/`. English instruction copies are in [i18n/en/skills](../../i18n/en/skills/) and [i18n/en/integrations](../../i18n/en/integrations/). Before configuring them, read [Skills and host integration](skills-and-hosts.md). The source includes actual adapter implementations; register them through your own host configuration rather than copying production account settings.

English materials use the same CLI, API identifiers, configuration keys, host identities, and storage protocol. Keep required Chinese filenames and shared-state headings intact. This edition translates documentation and instructions; it does not claim that every runtime message or host UI has been translated.
