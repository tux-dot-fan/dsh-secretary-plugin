# dsh-secretary（秘书插件）

DeepSeek Harness 秘书插件：**调度状态机 + 信息面板**。围绕一个持久化状态文件
（`$DSH_HOME/secretary/state.json`）提供 8 个模型工具：会话台账、任务委派跟踪、
任务清单、进度看板、汇报、催办、行为规则、交接。

## 一句话定位

**不替代 conversation-link：通信仍走它，秘书只记「什么任务、何时催、汇报什么」。**

所有实际收发都经 [dsh-conversation-link](https://github.com/duanyunlun/dsh-conversation-link) 的
`conversation_send`（程序化调用，走同一条工具策略管线）；秘书自身绝不实现消息框架/投递。
派发、催办、汇报、交接、规则变更全部写审计。

## 工具一览

| 工具 | 作用 | 备注 |
| --- | --- | --- |
| `secretary_roster` | 会话台账名片簿（handle/昵称/职责/当前任务/状态/cwd） | 只记录，不发消息 |
| `secretary_assign` | 委派任务：记录 + 封装 conversation_send 派单 | 已派→已收→待验收→逾期 |
| `secretary_tasks` | 任务清单查询 | 状态/assignee/截止/逾期过滤 |
| `secretary_board` | 进度看板：聚合 conversation_status | 只读，不唤醒 |
| `secretary_report` | 结构化主人汇报（含 markdown） | 生成留痕 |
| `secretary_remind` | 逾期催办 | 默认 dry-run（不打扰） |
| `secretary_policy` | 秘书自己的行为规则 | 只约束秘书，不约束会话 |
| `secretary_handoff` | 任务打包转交 | 原任务 handed_off 留痕 |

## 文档

- **[DESIGN.md](./DESIGN.md)** —— 设计文档（架构、状态机、接缝、阶段计划）
- `lib/state.js` —— 状态存储与任务状态机（原子写、审计环）
- `lib/transport.js` —— 通信接缝（经 tools.execute 调 conversation_send，降级留痕）
- `lib/schedule.js` / `lib/board.js` / `lib/report.js` —— 调度/看板/汇报
- `lib/tools.js` —— 8 个工具定义

## 开发

```bash
npm test          # node --test（当前为状态层冒烟测试）
```

## 安装

```bash
dsh plugin --profile <name> add dsh-secretary
```

或在 profile 的 `cordis.patch.yml` 手工 insert（二选一，勿重复挂载）。

## 状态文件

```jsonc
// $DSH_HOME/secretary/state.json  （config.stateDir 可覆盖）
{ "version": 1, "roster": {}, "tasks": {}, "policies": {}, "audit": [], "outbox": [] }
```

## 设计红线（详见 DESIGN.md）

1. 不替代 conversation-link —— 通信只走它，秘书只记录与转发；
2. 不越权 —— 决定权在各会话与主人，秘书无强制能力；
3. 可审计 —— 派发/催办/汇报/交接/规则变更全部留痕；
4. 骨架先行 —— 当前为骨架版本，通信路径降级可用，生产化点见 DESIGN.md 阶段计划。

