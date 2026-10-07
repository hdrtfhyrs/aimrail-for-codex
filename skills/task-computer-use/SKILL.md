---
name: task-computer-use
description: Local host and workflow additions for task-computer-use; use with the corresponding official upstream skill.
---

# Local adaptations for task-computer-use

These are the local additions and replacement instructions extracted from the installed upstream skill. Use the upstream skill from its official host distribution for unchanged instructions and third-party runtime files. The repository MIT licence applies to local additions only. Follow current user and host instructions when they override a historical rule. See [source and installation notes](UPSTREAM.md).

name: task-computer-use
description: Use the currently supplied computer/browser tools; preview local HTML through a scoped HTTP service, and control Windows apps only when native APIs are available.

## Choose the current tool surface

Read the actual tool description before choosing a runtime. When `mcp__cua_repl.js` is supplied, use its documented browser APIs for browser work. Its first call must be one permitted entry point, then read returned documentation. If it states that native computer APIs are disabled, do not initialize a separate native runtime to bypass that restriction. The legacy `sky` instructions below apply only when the current tool supply explicitly permits that native route.

For a self-contained local HTML artifact, use the read-only preview helper:

```powershell
node "tools/local-html-preview.mjs" start --file "ABS_HTML"
```

Open the returned `url` through `cua.createBrowserTab`, read its state, and inspect or click controls using documented APIs. The artifact runs in `iframe[sandbox="allow-scripts"]`; Playwright locators must use `tab.playwright.frameLocator("iframe")`. Save a real screenshot and verify the requested interaction before claiming preview success. The helper exposes only the selected snapshot on `127.0.0.1`, with no filesystem routes or external resource/API access. It is a materially narrower local-development preview, not a grant to read arbitrary local files. Multi-file applications should use their project's development server under the current browser policy.

The process defaults to a two-hour lifetime, is not a login/startup task, and repeated `start` calls reuse a live snapshot. After editing the HTML, call `stop --file ABS_HTML`, then `start` again. `status --file ABS_HTML` reports whether the helper is alive; an expired URL must be regenerated. Subagent IAB may reject `visible:true`; use `visible:false` for technical verification, and let the main task open the returned URL for the user. Protocol rejection, unavailable UI surfaces, external login, and OS ACL/UAC failures are distinct conditions; report the actual one.


- `docs/guidance.md`: core runtime behavior, target-window workflow, screenshot handling, and recovery guidance. You MUST read this before controlling Windows apps.
- `docs/api.md`: full `sky` API reference. Read this when you need method signatures or object shapes.
- `docs/confirmations.md`: you MUST read this before deciding whether a Windows UI action needs confirmation
