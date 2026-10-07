# 项目关联、当前任务与接续

本说明负责项目文件、绑定、状态更新和接续操作。新对话关联项目、切分支或接续缺材料时读取；通用行为沿integrations/AGENTS.md，压缩交接沿同目录compact.md。

## 项目文件各存什么

长期、反复且有最终想法的工作放workspace/projects/<项目名>/。一次性问答可保持未绑定。

| 文件 | 保存内容与更新时机 |
|---|---|
| 核心.md | 当前确认的完整目的、长期范围和成功标准。长期意思变化时按含义原位改写，合并重复、替换纠正；原话与历次变化留来源。 |
| 项目概况.md | 只维护全项目分支关系与当前材料入口；整体目的和共同条件以核心、共享状态为准，不在此复写。新增或退役分支时更新。 |
| 共享状态.md 的所属分支 | 本项完整目标、完成标准、有效条件、阶段、进度、负责人和依据。状态变化时更新本分支。 |
| 主线/<完整session_id>.md | 共享分支的定位、细节和旧证据。没有共享状态时，在此维护当前任务。 |
| 进展.md | 真正拍板、做成、失败和接续结果，以及必要返工反馈。没有观察到的效果写“未观察”。 |
| 成果/ | 可用成品、必要原件和维护说明。保存后沿既有成果目录登记。 |

只影响本项的条件和路线更新所属分支。读历史、原话、经验与成果补足依据；目录和父任务用于定位，当前职责沿用户交办及目标分支确定。修改旧核心前留必要恢复原件。

## 关联项目和目标分支

共同入口：integrations/context/project-context.mjs。

    node "integrations/context/project-context.mjs" read --project "项目绝对目录" --branch 稳定分支ID --compact
    node "integrations/context/project-context.mjs" read --project "项目绝对目录" --ledger "目标主线绝对路径" --compact
    node "integrations/context/project-context.mjs" bind --host codex --session 完整会话ID --cwd "工作目录" --project "项目绝对目录" --branch 稳定分支ID

host支持codex、claude、antigravity、shared；--json返回结构化定位。read只读，bind保存归属；已有绑定只在用户明确切换或纠正归属时用rebind修改。同一主线有多分支时指定稳定ID。Codex与Claude分别使用真实完整会话ID。

首次关联取得核心、整体关系和本项有效状态；接续旧决定或目标仍不明时，再读进展与相关原件。已有完整有效任务就直接使用，只补缺失或会改变下一步的材料。归属仍有会改变结果的歧义时问用户。

hook的会话主线用于定位。跨项目、跨分支或新执行者接手时，显式给目标项目、分支/主线和文件归属；父绑定与共享目录指针保留为来源，目标绑定由本项任务确定。

## 当前状态只在所属分支维护

目标和完成标准按累积原话写完整，进度另记。criteria用[ ]标未达、[x]标已有产物证实的结果。进度变化只改已做/下一步；用户改变目标或范围时，同步目标、标准、条件和依据。最新纠正优先，受影响行动前落盘并通知执行者。

读取和更新沿锁内合并接口：

    node "integrations/context/shared-state.mjs" read --project "项目绝对目录" --branch 稳定ID
    node "integrations/context/shared-state.mjs" update --project "项目绝对目录" --input "更新JSON绝对路径"

更新JSON含id与changes，仅给变化字段。支持阶段、负责人、已做、下一步、有效条件、主线、依据、本轮目标、完成标准；goal和criteria是后两项的别名。新建还需create:true、name及原七字段，goal/criteria补齐本项结果范围。例如：

    {"id":"稳定分支ID","changes":{"goal":"本轮完整结果与范围","criteria":["[ ] 未完成结果","[x] 已有产物证实的结果"]}}

首次建立沿核心、进展、相关主线和成果核事实，历史里程碑留原件出处。收尾按实际产物更新所覆盖标准，未达项继续保留。

没有共享状态的多轮任务，独立主线使用四节：

    # 当前分支
    项目/分支定位、终极目标入口、本轮完整目标与完成标准。
    # 有效状态
    用户已定条件、关键结论、缺口及来源；区分原话、实测和AI判断。
    # 阶段
    调研中 / 执行中及授权范围 / 完成 / 暂停。
    # 接续
    已有成果、关键原件、具体卡点及下一步。

## 完成分支归档

已交付且不再有本轮实际待办，或明确交由新分支接续的分支，可移至共享状态归档/；仍有待办、等待外部结果及在途工作保留。归档保留完整原文和未验边界，在共享状态的“已归档分支”留一行稳定ID索引，不代表未验事项已完成。

    node "integrations/context/shared-state.mjs" archive --project "项目绝对目录" --input "归档JSON绝对路径"

JSON为{ids:["分支ID"],expectedRevision:当前版本}。先读当前原件选择具体ID；版本变化时重新读，不覆盖并行修改。旧绑定、read、map expand仍按稳定ID读取归档正文；update同一ID会在锁内把完整分支移回当前分支并合并变化，无需改旧聊天绑定。归档历史不进入未绑定任务候选，仍可沿共享状态索引和map查到。

## 成果保存与聊天归档

项目及成果文件承载长期工作，聊天作为当前做事的工作台。本人已明确成果落盘后可以归档聊天，不必为了保留接续能力把所有旧聊天一直挂在侧栏。

本项结束时，把可用成果和必要原件保存登记，更新所属分支的实际结果、有效条件、未达项及下一步。本人已确认先归档已经结束且成果已落盘的工作聊天；完成这项保存后按此范围归档，实际待办、在途工作和当前仍在使用的聊天保留。接续者先读项目核心、该分支与成果入口，只有缺出处或需理解转折时再回查历史对话。归档聊天保留历史，不代替分支完成，也不删除成果、原数据或持续运行程序。

本人要求整理现有聊天时，先按其指定范围取得真实聊天、所属分支和已保存成果，处理能确认已结束的对象；尚待接续的聊天按本人本次范围处理。当前正在使用、在途执行或本人指定保留的聊天，保留其用途，不用空闲状态或一次回合结束推断工作完成。不能仅因存在一个成果文件就归档全部未完成任务。

归档用当前宿主提供的正式聊天接口，保存真实ID、原标题、项目/分支及成果入口，方便恢复和查找。Codex使用set_thread_archived；需要恢复时按同一ID取消归档。批量处理先保存范围和接续入口，再逐项记录实际结果；接口失败时保留待处理项，不以文件登记代替界面已归档。

## 执行者替换及旧主线迁移

执行者交接本项完整目标、标准、条件、授权、产物、未达项和可访问原件，接收方从文件继续；分工及新执行者调用沿outcome-collaboration。移交写入责任前保存状态，旧写入者退出该块，其他在途授权继续。

迁移旧主线或日期文件时，核正文session_id完整标记与当前会话一致，并查原对话有效条件。确认不了就保留旧路径待核，历史和出处留原处。

## 原话怎样融合成当前条件

普通补充由当前AI结合完整任务理解，稳定后更新同一份条件。复杂纠正、跨聊天整理或交接按需用独立整理AI。原话及版本由程序保留；候选由负责人整合后写回所属分支。

现有模块入口和候选格式：modules/system/任务协作/context-manager/README.md。

    node "modules/system/运行中心/system.mjs" context prepare --project "项目绝对目录" --branch 稳定ID --messages "原话JSON绝对路径" --job-dir "本次新job绝对目录"
    node "modules/system/运行中心/system.mjs" context apply --job "本次job目录/job.json" --candidate "本次job目录/candidate.json"
    node "modules/system/运行中心/system.mjs" context context --project "项目绝对目录" --branch 稳定ID --out "接续正文绝对路径.md"

prepare取得prompt.md、input.json及candidate-template.json；按这些材料写candidate.json，再apply。首次apply前prepare/context共用来源目录；之后沿分支archive指针读取。基线变化拒绝旧job时重新prepare；goal/criteria变化用共享状态接口另行维护。

context附当前完整分支与未融合原话；--messages会持久摄入新话。hook摄入只覆盖明确绑定且已有首次apply标记的分支。相邻问答提供指代背景，用户原话与助手解释分别作为来源；缺来源或歧义留明。

contextPlan用active表示已融入conditions，reference保留出处，open保留未解决讨论及必要背景。按省略后是否改变理解或下一动作分配材料，未解决讨论继续接续。完整参数与并发细节沿模块README展开。

## 收尾要交实际成果

展示要求沿AGENTS.md的“协作与交付”。成品存所属项目成果/，先看成果/INDEX.md，再登记：

    node "integrations/context/deliverables.mjs" --help
    node "integrations/context/deliverables.mjs" register --project "项目绝对目录" --input "登记JSON绝对路径"

登记JSON写directory、entry、title、summary、status、boundary、next、branch、ledger、evidence；save还支持files复制明确成品。查找使用search/read，整体入口workspace/projects/成果总览.md。

沿现有展厅打开登记成果或过程成品：

    node "modules/system/成果展厅/showcase.mjs" open --ref 登记编号
    node "modules/system/成果展厅/showcase.mjs" open --file "成品绝对路径"

浏览器面板可用url取地址。重要成果的展示.json格式见成果/2026-10-03_成果展厅/使用说明.md；软件学习材料沿workspace/memory/knowledge/从实际软件学习开发.md。

## 按需工具导航

- 本地环境与跨宿主对话：node "integrations/context/workspace.mjs" help；操作沿modules/system/本地统一/共同声明.md。
- 知识与纠错：workspace/memory/knowledge/INDEX.md；workspace/memory/errors/WRITING.md。
- 精确清理：integrations/context/system-maintenance.mjs。
- 浏览器和HTML预览：task-computer-use。单文件用node "tools/local-html-preview.mjs" start --file "绝对路径"；修改后stop再start，多文件用项目开发服务。
