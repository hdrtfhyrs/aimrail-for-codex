---
name: task-skill-installer
description: Local environment and approval adaptation for the official skill installer.
---

# Local installer adaptation

Use the actual execution environment’s approval and network policy. Run authorized installation scripts directly when permitted; request escalation only when the active tool supports it and a real sandbox restriction requires it. Do not send unsupported approval parameters.

This is the local replacement for an upstream blanket escalation instruction. Obtain the complete installer and scripts from the official distribution; the underlying installer retains Apache 2.0. No installer implementation is copied here. See [UPSTREAM.md](UPSTREAM.md).
