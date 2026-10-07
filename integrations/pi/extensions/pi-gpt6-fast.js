// Optional Fast processing for the three GPT-6 models on Pi's Codex provider.
// Fast is session-scoped and off by default; /fast on enables it.
export default function (pi) {
  const enabledSessions = new Set();
  const models = new Set(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]);

  pi.registerCommand("fast", {
    description: "Toggle GPT-6 Fast processing for this session: /fast on|off|status",
    handler: async (args, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const action = args.trim().toLowerCase() || "status";
      if (action === "on") enabledSessions.add(sessionId);
      else if (action === "off") enabledSessions.delete(sessionId);
      else if (action !== "status") {
        ctx.ui.notify("Use /fast on, /fast off, or /fast status", "warning");
        return;
      }
      const enabled = enabledSessions.has(sessionId);
      ctx.ui.notify(
        `GPT-6 Fast: ${enabled ? "on (requests priority processing; may use more quota)" : "off"}`,
        "info",
      );
    },
  });

  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    if (model?.provider !== "openai-codex" || !models.has(model.id)) return;
    if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;

    const payload = { ...event.payload };
    let changed = false;

    // Pi 0.85.1 omits reasoning when its UI level is "off". Sol and Luna
    // otherwise default to medium, so request their supported none level.
    if ((model.id === "gpt-6-sol" || model.id === "gpt-6-luna") && ctx.thinkingLevel === "off") {
      payload.reasoning = { effort: "none", summary: "auto" };
      changed = true;
    }

    if (enabledSessions.has(ctx.sessionManager.getSessionId()) || process.env.PI_GPT6_FAST_TEST === "1") {
      payload.service_tier = "priority";
      changed = true;
    }

    return changed ? payload : undefined;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    enabledSessions.delete(ctx.sessionManager.getSessionId());
  });
}
