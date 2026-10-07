# English and Chinese editions

[English home](../../README.md) · [中文首页](../../README.zh-CN.md)

The English edition includes the main README, all eight operational guides in this directory, authored skills, local skill adaptations, role instructions, handoff prompts, project templates and fictional examples. The Chinese edition remains available through `README.zh-CN.md`, the original `docs/` guides and the original instructions. Both use the same implementation.

Use English templates when creating a workspace and project:

```powershell
node bin/ai-work.mjs init --workspace ./workspace --language en
node bin/ai-work.mjs project init --workspace ./workspace --language en --name "Source Organizer" --goal "Organize material by topic and retain its sources"
```

The language flag selects the instruction text used by these initialization commands. It does not overwrite existing files or translate an existing project. Specify `--language en` for each new English initialization; `zh-CN` is the original default.

English instructions are stored in [`i18n/en`](../../i18n/en/). Adopt the independent skills and host templates you need. Task-specific additions still require their corresponding official upstream skill; an English translation does not turn a local adaptation into the full upstream package.

## Protocol names retained for compatibility

The underlying readers locate specific filenames and shared-state headings. English prose and project goals are supported while these names remain unchanged:

| Name in the files or commands | Meaning |
|---|---|
| `核心.md` | Project objective and lasting conditions |
| `共享状态.md` | Current shared task state |
| `项目概况.md` | Project and branch relationships |
| `进展.md` | Actual progress and decisions |
| `主线/` | Detailed continuation records |
| `成果/` | Delivered artifacts |
| `## 共同条件` | Shared conditions |
| `## 当前分支` | Active branches |
| `## 已完成里程碑` | Completed milestones |
| `阶段` / `phase` | Task phase |
| `负责人` / `owner` | Responsible executor |
| `已做` / `done` | Work actually completed |
| `下一步` / `next` | Next action |
| `有效条件` / `conditions` | Conditions currently in force |
| `主线` / `ledger` | Absolute Markdown continuation path, or the sentinel `无` |
| `依据` / `evidence` | Evidence and authorization source |
| `本轮目标` / `goal` | Complete objective of the current task |
| `完成标准` / `criteria` | Completion criteria |

English JSON aliases on the right can be used with `state update`. The persistent Markdown field labels on the left are retained by the implementation. Keep `<!-- shared-state revision:N -->`, stable branch IDs and the prescribed headings intact. `无` is an accepted no-ledger sentinel; the English word `none` is not a replacement for it.

Chinese directory names in `modules/system/` are source paths, so copy command paths exactly as shown. The English edition localizes documentation and authored instructions. It does not claim that every web interface, runtime message or parser has been localized.
