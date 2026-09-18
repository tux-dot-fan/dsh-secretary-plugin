# dsh-secretary 设计文档

> 秘书插件：**调度状态机 + 信息面板**。本文说明整体架构、状态模型、工具契约、
> 通信接缝与阶段计划。骨架版已可按本文落地实现。

## 1. 定位

秘书不是又一个通信层，也不是任务执行者。它是一本**会提醒的台账**：

- **记录**：谁（handle/昵称/职责）在干什么（当前任务/状态/cwd），被派了什么任务（已派/已收/待验收/逾期）；
- **转发**：派单、催办、交接消息全部经底层通信层送出，秘书**不实现任何消息框架/投递**；
- **汇报**：把多会话产出聚合成结构化主人汇报（board 一屏概要 / report 全文）。

决定权在各会话与主人：秘书只登记事实、转发请求、按规则提醒，从不对任何会话施加约束。

## 2. 设计红线（不可让步）

| 红线 | 含义 | 落地方式 |
| --- | --- | --- |
| 不替代 conversation-link | 通信仍走它 | `transport.js` 统一接缝：经 host `tools.execute` 程序化调用已注册的 `conversation_send`，与模型直接调用走同一条 pre/post-execute 管线（规则护栏同样覆盖） |
| 不越权 | 只记录和转发，决定权在各会话/主人 | 秘书工具全部只读 conversation-link 的只读接口（list/status）+ 自持状态；对任何会话无强制入口 |
| 可审计 | 派发/催办/汇报/交接/规则变更留痕 | `state.audit` 有界审计环，每个变更事件带 at/by/taskId/detail |
| 状态单点原子写 | 状态文件可靠 | `$DSH_HOME/secretary/state.json`，写 `.tmp` 后 rename，整份重写 |

## 3. 总体架构

```
                    ┌──────────────────────────────────────────────┐
                    │              host（DeepSeek Harness）         │
                    │                                              │
  ┌─────────────┐   │   ┌──────────────────────────────────────┐   │
  │ dsh-        │   │   │ dsh-secretary                        │   │
  │ conversation│   │   │ ┌──────────┐  ┌─────────────────────┐ │   │
  │ -link (通信层)│◄──┼───►│transport │◄─│ tools.js（8 工具）    │ │   │
  │ list/send/  │   │   │ (接缝)    │  │ roster/assign/tasks  │ │   │
  │ status/rule │   │   └────▲─────┘  │ board/report/remind/  │ │   │
  │             │   │        │        │ policy/handoff        │ │   │
  └──────┬──────┘   │        │        └──────────┬────────────┘ │   │
         │ 只读      │   ┌────┴─────┐            │              │   │
         │ status   │   │ schedule │◄───────────┘              │   │
         │          │   │ board    │  核实/催办口径             │   │
         │          │   │ report   │                            │   │
         │          │   └────┬─────┘                            │   │
         │          │   ┌────┴──────────────────────────────┐   │   │
         │          │   │ StateStore（lib/state.js）          │   │   │
         │          │   │ $DSH_HOME/secretary/state.json     │   │   │
         │          │   │ roster/tasks/policies/audit/outbox │   │   │
         │          │   └────────────────────────────────────┘   │   │
         └──────────┼────────────────────────────────────────────┼──┘
                    │  工具注册/事件钩子（conversation/deleted）       │
                    └──────────────────────────────────────────────┘
```

### 模块清单（骨架版）

| 文件 | 职责 | 状态 |
| --- | --- | --- |
| `index.js` | 插件入口：挂载、注册工具、订阅删除事件、mount 诊断 | ✅ 完整 |
| `lib/state.js` | StateStore：versioned 状态、原子写、任务状态机、审计环、outbox | ✅ 完整 |
| `lib/schedule.js` | 逾期判定、催办候选、模板渲染、不打扰模式判定 | ✅ 完整 |
| `lib/report.js` | 汇报组装（summary/sections/markdown） | ✅ 完整 |
| `lib/tools.js` | 8 个工具定义（schema + execute） | 🟡 骨架可用：状态层完整，通信走接缝 |
| `lib/transport.js` | 通信接缝：tools.execute 调 conversation_send；降级 outbox | 🟡 接缝就绪，结果解析待真机校准 |
| `lib/board.js` | 看板聚合（conversation_list + conversation_status + roster 叠加） | 🟡 骨架可用，progress 字段待 phase-2 |
| `test/state.test.mjs` | 状态层冒烟测试 | ✅ 已写（需在正常 DSH 环境 node --test） |

## 4. 状态模型（state.json）

```jsonc
{
  "version": 1,
  "roster": {                // 会话台账（key = handle，可说出口的名字）
    "amber-heron": { "key": "amber-heron", "sessionId": "session-...",
      "nickname": "小鹰", "role": "调研", "status": "busy",
      "cwd": "/home/...", "currentTask": "竞品分析", "note": "", "updatedAt": 1730000000000 }
  },
  "tasks": {                 // 任务记录（委派跟踪唯一事实源）
    "S-KX3ABC-1": { "id": "S-KX3ABC-1", "subject": "写竞品分析", "assignee": "amber-heron",
      "sender": "owner-session", "status": "pending_accept", "sent": true,
      "deadline": "2030-01-02T03:00:00.000Z", "priority": "high", "note": "",
      "dispatchedAt": 1730000000000, "receivedAt": 1730000100000, "acceptedAt": 1730000200000,
      "completedAt": 0, "remindedAt": 0, "handedOffAt": 0, "cancelledAt": 0,
      "handoffNote": "", "reminders": [], "updatedAt": 1730000200000 }
  },
  "policies": {              // 秘书自己的行为规则覆盖（缺省用 POLICY_DEFAULTS）
    "nonIntrusive": true, "remindGraceMinutes": 60, "remindTemplate": "..."
  },
  "audit": [ { "at": "...", "event": "task.dispatched", "by": "owner", "taskId": "S-...", "detail": "..." } ],
  "outbox": []               // transport 降级时的待送达消息（deferred 留痕）
}
```

## 5. 任务状态机

```
                 ┌─────────────┐
     派单 ──────►│ dispatched  │◄────────── 待送达（sent=false/降级）
                 └──────┬──────┘
                        │ 对方回复/收到（receivedAt）
                 ┌──────▼──────┐
                 │  received   │
                 └──────┬──────┘
                        │ 确认验收（acceptedAt）
                 ┌──────▼──────────┐
                 │  pending_accept │
                 └──────┬──────────┘
                        │ 完成（completedAt）
                 ┌──────▼──────┐
                 │     done    │
                 └─────────────┘

  任意未终结态 ──► cancelled | handed_off（交接：assignee 改派 + handoffNote）

  overdue 是派生状态：deadline 已过 && 未终结（不落盘，isOverdue() 现算）
```

迁移规则：终结态（done/cancelled/handed_off）不可再迁移；每次迁移写审计
`task.status:<旧>-><新>`。

## 6. 工具契约与数据流

| 工具 | 入参要点 | 数据流 |
| --- | --- | --- |
| `secretary_roster` | action=list/upsert/remove；handle/sessionId/nickname/role/status/cwd/currentTask | 纯 store 操作 + 审计；**不发任何消息** |
| `secretary_assign` | to(必)、subject(必)、deadline、priority、message、quiet、send | ① store.taskCreate（dispatched）→ ② transport.send(conversation_send) → ③ sent=true 回写 + 审计；send=false 只记录 |
| `secretary_tasks` | status/assignee/overdue/limit | store 过滤 + isOverdue 派生，纯读 |
| `secretary_board` | scope | ① conversation_list 取会话 → ② 每会话 conversation_status（只读不唤醒）→ ③ 叠加 roster + 逾期标记 |
| `secretary_report` | scope=open/all/overdue/done、since | buildReport 纯组装 + 审计「report.generated」 |
| `secretary_remind` | taskId/graceMinutes/dryRun/template | collectDueTasks（宽限+提醒上限）→ dry-run 只预览（默认，遵循 nonIntrusive）→ 真发时 transport.send(mode=inject 不唤醒) + taskRemind 留痕 |
| `secretary_policy` | action=list/set/clear；key/value | 仅限 POLICY_DEFAULTS 已知键；变更审计 |
| `secretary_handoff` | to(必)、from/taskIds、note、send | taskHandoff（→handed_off 留痕 + 改派）→ 打包交接包 → transport.send 给接任人 |

## 7. 通信接缝（transport.js）—— 不重造通信层的关键

需求冲突点：`secretary_assign` 要「封装 conversation_send」，但红线要求「不替代 conversation-link」。
解法：**程序化调用已注册的 conversation_send 工具**。

- host 的 `tools` 服务暴露 `execute(exec)`：传入 `{ name: "conversation_send", agent, arguments: {...} }`，
  与模型直接调用走**同一条** pre-execute/post-execute 策略管线 —— conversation-link 的规则护栏、
  审计、投递模式（auto/queue/steer/inject）对秘书发出的消息同样生效；
- 能力探测 `tools.get("conversation_send", agent)`：conversation-link 未挂载时返回 false；
- **降级（fail-open）**：conversation-link 缺失/调用失败 → 消息落 `state.outbox`（deferred），
  任务仍记录、审计仍留痕，调度状态机不被通信故障打断；由主人/模型后续补发；
- 骨架阶段的 `unwrapText`/结果判定按防御式写法，真机校准点：tools.execute 返回快照的精确形状。

## 8. 与现有插件的关系

| 插件 | 关系 | 说明 |
| --- | --- | --- |
| dsh-conversation-link | **唯一通信层**（peerDep optional） | 本插件只经其工具通信，不 import 其内部实现 |
| dsh-tool-session | 旁路参考 | 会话创建/改名/归档由它管；秘书台账里的 cwd/会话状态可在 roster 手动登记，也可走它的只读接口（phase-3 增强） |
| dsh-skill-evolution | 旁路参考 | 秘书自身的规则/流程沉淀可与技能自进化解耦，暂不集成 |
| dsh-agent-teams | 复杂任务才用 | 秘书负责台账与催办层；真正需要 DAG 团队执行时由秘书工具**转发**给 agent-teams 场景（phase-3 设计点） |

## 9. 审计与安全

- 每个变更事件（task.dispatched / task.status:*/task.reminded / task.handoff / roster.* / policy.* / report.generated）
  都进 `audit`，有界（默认 500 条，policy.auditLimit 可调），`recentAudit()` 新在前；
- 秘书无强制能力：全部工具读会话状态都走 conversation-link 的只读接口；写操作只写秘书自己的状态文件；
- 状态文件单点：整写 + rename 原子替换；损坏文件按空状态处理并在挂载时告警，绝不炸挂载；
- 规则只约束秘书自己：`secretary_policy` 仅允许 POLICY_DEFAULTS 已知键，且不约束任何会话。

## 10. 阶段计划

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 骨架 | 目录/package/cordis.patch.yml/模块骨架/DESIGN | ✅ 本次交付 |
| P1 状态层收口 | 状态机补流转工具（secretary_accept/complete 之类的收口入口）、schema 字段审计 | ⏳ |
| P2 通信真机校准 | transport 结果解析按 tools.execute 真实快照定型；remind 按 assignee 过滤；后台定时 tick（cordis timer）做无人值守催办 | ⏳ |
| P3 信息面板增强 | board progress 归一化；settings.yaml 配置区（@deepseek-ai/dsh-settings，仿 tool-session）；与 dsh-agent-teams 的转发协作点 | ⏳ |
| P4 打磨 | 迁移 v2、UI 面板（可选）、README.en | ⏳ |

## 11. 验证方式

1. `npm test` —— 状态层冒烟测试（9 例，已通过）；\n2. `npm run smoke` —— 最小宿主挂载冒烟（8 工具注册 / 状态操作 / 降级路径，已通过）；
2. 在 web profile 挂载后：`ls $DSH_HOME/secretary/` 应见 `mount.json` 与 `state.json`；
3. 模型面 smoke：`secretary_roster`(list) → `secretary_assign`(send=false) → `secretary_tasks`(overdue=true用过去截止造数) →
   `secretary_remind`(dry-run 预览) → `secretary_report` → `secretary_handoff`(send=false)。
