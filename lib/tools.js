/**
 * secretary 的 8 个模型工具：调度状态机的对外操作面。
 *
 * 职责边界：
 *   - 记录与转发 —— 状态一律进 StateStore；消息一律走 transport（conversation-link）
 *   - 不越权 —— 只登记「什么任务 / 何时催 / 汇报什么」，决定权在各会话与主人
 *   - 可审计 —— 派发/催办/汇报/交接/规则变更全部写 audit
 *
 * 工具骨架说明：状态层（roster/tasks/policies/audit）已可用；通信层（assign/
 * remind/handoff 的 send 路径）经 transport 接缝接入 conversation-link，
 * conversation-link 未挂载时自动降级为 deferred（留痕不丢）。
 *
 * @module dsh-secretary/tools
 */

import { createTransport } from './transport.js'
import { collectBoard } from './board.js'
import { buildReport } from './report.js'
import { collectDueTasks, renderTemplate, resolveRemindMode } from './schedule.js'
import { POLICY_DEFAULTS, isOverdue } from './state.js'

/**
 * 把「每个属性一个 schema + required 标记」的属性表编译成模型看到的 object schema。
 * 与 dsh-conversation-link 的 compileParameters 同一写法（参考其 MIT 代码结构）。
 */
function compileParameters(spec) {
  const properties = {}
  const required = []
  for (const [key, node] of Object.entries(spec)) {
    const info = { ...node }
    const isRequired = info.required === true
    delete info.required
    properties[key] = info
    if (isRequired) required.push(key)
  }
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length === 0 ? {} : { required }),
  }
}

/** 构建一个工具定义（name/description/parameters/output/execute 的标准形状）。 */
function defineTool(detail) {
  return {
    name: detail.name,
    description: detail.description,
    parameters: compileParameters(detail.parameters),
    output: {
      schema: detail.output,
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
    },
    execute: detail.run,
  }
}

/** 拒绝没有宿主会话的调用（conversation 工具都要求身份）。 */
function requireAgent(exec) {
  if (exec.agent === undefined) {
    throw new Error("dsh-secretary: 秘书工具需要一个宿主会话身份的调用方")
  }
  return exec.agent
}

/** 把 deadline 入参规整成 ISO 或空串（兼容 ISO 与 YYYY-MM-DD）。 */
function normalizeDeadline(value) {
  if (typeof value !== "string" || value.length === 0) return ""
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return ""
  return new Date(parsed).toISOString()
}

/** 派单消息的默认文案（可被 args.message 覆盖）。 */
function composeDispatchMessage(task) {
  const deadline = task.deadline ? "，截止 " + task.deadline : ""
  return "【秘书派单】请接任务「" + task.subject + "」" + deadline
    + "（任务号 " + task.id + "）。收到请回复一声进展。"
}

/** 交接消息的默认文案。 */
function composeHandoffMessage(pkg) {
  let message = "【秘书交接】你被指派接管 " + pkg.items.length + " 项未完任务："
  for (const item of pkg.items) message += "\n- [" + item.id + "] " + item.subject
  if (pkg.note) message += "\n备注：" + pkg.note
  return message
}

/**
 * 构建并返回全部秘书工具。
 * @param ctx    host 上下文。
 * @param store  StateStore。
 * @returns 8 个工具定义。
 */
export function createTools(ctx, store) {
  const transport = createTransport(ctx, store)

  return [
    // =================================================================
    // 1/8 secretary_roster —— 会话台账（名片簿）
    // =================================================================
    defineTool({
      name: "secretary_roster",
      description: "会话台账名片簿：登记/查看各会话的 handle、昵称、职责、当前任务、状态、cwd。"
        + "action=upsert 时 handle 或 sessionId 至少给一个（缺省用调用方自己）；"
        + "action=remove 移除名片。台账只记录，不向对方发任何消息。",
      parameters: {
        action: {
          type: "string",
          enum: ["list", "upsert", "remove"],
          description: "list=查全部名片（默认）；upsert=登记/更新；remove=移除。",
        },
        handle: { type: "string", description: "会话 handle（conversation_list 返回的 selfHandle/peer handle）。" },
        sessionId: { type: "string", description: "会话 sessionId；handle 缺省时用它做台账键。" },
        nickname: { type: "string", description: "昵称（给人看的名字）。" },
        role: { type: "string", description: "职责，如 调研/开发/审校。" },
        status: { type: "string", description: "状态，如 idle/busy/blocked/paused。" },
        cwd: { type: "string", description: "工作目录。" },
        currentTask: { type: "string", description: "当前任务一句话。" },
        note: { type: "string", description: "备注。" },
      },
      output: {
        type: "object",
        additionalProperties: false,
        required: ["action", "entries"],
        properties: {
          action: { type: "string" },
          entries: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["key", "nickname"],
              properties: {
                key: { type: "string" },
                sessionId: { type: "string" },
                nickname: { type: "string" },
                role: { type: "string" },
                status: { type: "string" },
                cwd: { type: "string" },
                currentTask: { type: "string" },
                note: { type: "string" },
                updatedAt: { type: "number" },
              },
            },
          },
        },
      },
      run: (args, exec) => {
        const agent = requireAgent(exec)
        const action = args.action ?? "list"
        if (action === "remove") {
          const key = args.handle ?? args.sessionId
          const removed = key === undefined ? undefined : store.rosterRemove(key)
          store.audit({ event: "roster.remove", by: agent.id, detail: key ?? "(none)" })
          return { action, entries: removed === undefined ? [] : [removed] }
        }
        if (action === "upsert") {
          const key = args.handle ?? args.sessionId ?? agent.id
          const entry = store.rosterUpsert(key, {
            sessionId: args.sessionId ?? (args.handle === undefined ? agent.id : ""),
            nickname: args.nickname,
            role: args.role,
            status: args.status,
            cwd: args.cwd,
            currentTask: args.currentTask,
            note: args.note,
          }, ctx.get("logger"))
          if (entry !== undefined) store.audit({ event: "roster.upsert", by: agent.id, detail: key })
          return { action, entries: entry === undefined ? [] : [entry] }
        }
        return { action, entries: store.rosterAll() }
      },
    }),
    // =================================================================
    // 2/8 secretary_assign —— 任务委派跟踪（封装 conversation_send）
    // =================================================================
    defineTool({
      name: "secretary_assign",
      description: "委派任务：记录任务（已派，带截止/优先级），并封装 conversation_send 把派单消息"
        + "发给接收人。消息实际投递经 conversation-link（send=false 时只记录不发送）；"
        + "投递失败自动降级 deferred（落 outbox，不丢留痕）。",
      parameters: {
        to: { type: "string", required: true, description: "接收人 handle 或 sessionId。" },
        subject: { type: "string", required: true, description: "任务一句话（标题）。" },
        deadline: { type: "string", description: "截止时间，ISO 8601 或 YYYY-MM-DD。" },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"], description: "优先级，默认 normal。" },
        message: { type: "string", description: "自定义派单消息；缺省按任务生成。" },
        quiet: { type: "boolean", description: "true 时不唤醒对方（inject 静默送达），默认 false。" },
        send: { type: "boolean", description: "false=只记录不发送；默认 true。" },
        note: { type: "string", description: "内部备注（不进派单消息）。" },
      },
      output: {
        type: "object",
        additionalProperties: false,
        required: ["task", "delivery"],
        properties: {
          task: { type: "object" },
          delivery: {
            type: "object",
            additionalProperties: true,
            required: ["delivered"],
            properties: { delivered: { type: "string" } },
          },
        },
      },
      run: async (args, exec) => {
        const agent = requireAgent(exec)
        const to = typeof args.to === "string" && args.to.length > 0 ? args.to : undefined
        const subject = typeof args.subject === "string" && args.subject.length > 0 ? args.subject : undefined
        if (to === undefined) throw new Error("secretary_assign: 缺少接收人 to")
        if (subject === undefined) throw new Error("secretary_assign: 缺少任务 subject")
        const task = store.taskCreate({
          subject,
          assignee: to,
          sender: agent.id,
          deadline: normalizeDeadline(args.deadline),
          priority: args.priority ?? "normal",
          note: args.note ?? "",
          sent: false,
        }, { by: agent.id })
        if (args.send === false) {
          return { task, delivery: { delivered: "deferred", reason: "send=false" } }
        }
        const message = typeof args.message === "string" && args.message.length > 0
          ? args.message
          : composeDispatchMessage(task)
        const mode = args.quiet === true ? "inject" : "auto"
        const delivery = await transport.send({ target: to, message, mode, agent })
        if (delivery.delivered === "sent") {
          store.taskUpdate(task.id, { sent: true }, { by: agent.id })
        }
        return { task: store.taskGet(task.id), delivery }
      },
    }),

    // =================================================================
    // 3/8 secretary_tasks —— 任务清单查询
    // =================================================================
    defineTool({
      name: "secretary_tasks",
      description: "查询任务清单：按状态（dispatched/received/pending_accept/done/overdue）、"
        + "assignee、是否逾期过滤；逾期是派生状态（截止已过且未终结）。",
      parameters: {
        status: { type: "string", description: "过滤状态；overdue 也可作为状态值。" },
        assignee: { type: "string", description: "按接收人（handle/sessionId）过滤。" },
        overdue: { type: "boolean", description: "true=只看逾期。" },
        limit: { type: "number", description: "最多返回条数（默认全部）。" },
      },
      output: {
        type: "object",
        additionalProperties: false,
        required: ["count", "tasks"],
        properties: {
          count: { type: "number" },
          overdueCount: { type: "number" },
          tasks: { type: "array", items: { type: "object" } },
        },
      },
      run: (args) => {
        const now = Date.now()
        let tasks = store.tasksAll()
        if (typeof args.status === "string" && args.status.length > 0) {
          tasks = tasks.filter(t => (isOverdue(t, now) ? "overdue" : t.status) === args.status)
        }
        if (typeof args.assignee === "string" && args.assignee.length > 0) {
          tasks = tasks.filter(t => t.assignee === args.assignee)
        }
        if (args.overdue === true) tasks = tasks.filter(t => isOverdue(t, now))
        const total = tasks.length
        if (typeof args.limit === "number" && Number.isFinite(args.limit)) {
          tasks = tasks.slice(0, Math.max(1, Math.floor(args.limit)))
        }
        return {
          count: total,
          overdueCount: tasks.filter(t => isOverdue(t, now)).length,
          tasks: tasks.map(t => ({ ...t, displayStatus: isOverdue(t, now) ? "overdue" : t.status })),
        }
      },
    }),

    // =================================================================
    // 4/8 secretary_board —— 进度看板
    // =================================================================
    defineTool({
      name: "secretary_board",
      description: "进度看板：聚合各会话的 conversation_list + conversation_status，"
        + "叠加台账职责/当前任务与逾期标记，生成一屏概要。"
        + "某会话状态读不到会标 unreachable，不阻断整板。",
      parameters: {
        scope: { type: "string", enum: ["workspace", "all"], description: "会话作用域，默认 policy.boardScope。" },
      },
      output: {
        type: "object",
        additionalProperties: true,
        required: ["at", "scope", "entries"],
        properties: {
          at: { type: "string" },
          scope: { type: "string" },
          entries: { type: "array", items: { type: "object" } },
          summary: { type: "object" },
        },
      },
      run: async (args, exec) => {
        const agent = requireAgent(exec)
        const board = await collectBoard(ctx, store, { scope: args.scope, agent })
        return {
          ...board,
          summary: { sessions: board.entries.length, unreachable: board.unreachable.length },
        }
      },
    }),

    // =================================================================
    // 5/8 secretary_report —— 汇报生成
    // =================================================================
    defineTool({
      name: "secretary_report",
      description: "生成结构化主人汇报：汇总多会话任务产出（进行中/逾期/已完成），"
        + "按执行会话分桶，附 markdown 版供直接贴出。生成动作留痕审计。",
      parameters: {
        scope: { type: "string", enum: ["open", "all", "overdue", "done"], description: "汇报范围，默认 open。" },
        since: { type: "string", description: "ISO 时间；只统计该时刻之后完成的任务。" },
      },
      output: {
        type: "object",
        additionalProperties: false,
        required: ["summary", "markdown"],
        properties: {
          summary: { type: "object" },
          sections: { type: "array", items: { type: "object" } },
          markdown: { type: "string" },
        },
      },
      run: (args, exec) => {
        const agent = requireAgent(exec)
        const report = buildReport({
          tasks: store.tasksAll(),
          scope: args.scope,
          since: args.since,
        })
        store.audit({
          event: "report.generated",
          by: agent.id,
          detail: report.summary.scope + "（open " + report.summary.open + " / overdue " + report.summary.overdue + "）",
        })
        return { summary: report.summary, sections: report.sections, markdown: report.markdown }
      },
    }),

    // =================================================================
    // 6/8 secretary_remind —— 催办（不打扰模式）
    // =================================================================
    defineTool({
      name: "secretary_remind",
      description: "催办：找出逾期（截止+宽限）且未终结、未超提醒上限的任务；"
        + "默认 dry-run（只预览不发送，遵循 policy.nonIntrusive）；dryRun=false 时经"
        + "conversation-link 以 inject（不唤醒）模式送达并留痕。",
      parameters: {
        taskId: { type: "string", description: "只催指定任务（缺省催全部应催的）。" },
        assignee: { type: "string", description: "只催指定接收人（TODO(phase-2)：按人过滤实现）。" },
        graceMinutes: { type: "number", description: "宽限分钟数，默认 policy.remindGraceMinutes。" },
        dryRun: { type: "boolean", description: "缺省跟随 policy.nonIntrusive；false=真的发送。" },
        template: { type: "string", description: "催办文案模板（缺省用 policy.remindTemplate）。" },
      },
      output: {
        type: "object",
        additionalProperties: false,
        required: ["mode", "count"],
        properties: {
          mode: { type: "string" },
          dryRun: { type: "boolean" },
          count: { type: "number" },
          due: { type: "array", items: { type: "object" } },
          sent: { type: "array", items: { type: "object" } },
        },
      },
      run: async (args, exec) => {
        const agent = requireAgent(exec)
        const graceMinutes = Number(args.graceMinutes) || store.policy("remindGraceMinutes")
        let candidates = []
        if (typeof args.taskId === "string" && args.taskId.length > 0) {
          const task = store.taskGet(args.taskId)
          if (task !== undefined && isOverdue(task)) candidates = [{ task }]
        } else {
          candidates = collectDueTasks(store.tasksAll(), {
            graceMs: graceMinutes * 60_000,
            maxPerTask: store.policy("remindMaxPerTask"),
          })
        }
        const mode = resolveRemindMode(store.policy("nonIntrusive"), args.dryRun)
        const due = candidates.map(c => c.task)
        if (mode === "dry-run") {
          return {
            mode,
            dryRun: true,
            count: due.length,
            due: due.map(t => ({ id: t.id, subject: t.subject, assignee: t.assignee, deadline: t.deadline })),
            sent: [],
            note: "未发送任何消息（不打扰模式）。确认无误后请以 dryRun=false 重跑。",
          }
        }
        const sent = []
        const template = typeof args.template === "string" && args.template.length > 0
          ? args.template
          : store.policy("remindTemplate")
        for (const t of due) {
          const message = renderTemplate(template, t)
          const delivery = await transport.send({ target: t.assignee, message, mode: "inject", agent })
          store.taskRemind(t.id, {
            by: agent.id,
            mode: delivery.delivered,
            detail: String(delivery.reason ?? delivery.result ?? ""),
          })
          sent.push({ id: t.id, assignee: t.assignee, delivered: delivery.delivered })
        }
        return { mode, dryRun: false, count: sent.length, due, sent }
      },
    }),

    // =================================================================
    // 7/8 secretary_policy —— 行为规则
    // =================================================================
    defineTool({
      name: "secretary_policy",
      description: "秘书自己的行为规则：list=查看生效规则（默认+覆盖），set/clear=改规则。"
        + "规则只约束秘书自己（催办宽限、不打扰开关、模板、看板/汇报默认值），"
        + "不约束任何会话；变更全部留痕审计。",
      parameters: {
        action: { type: "string", enum: ["list", "set", "clear"], description: "list=查看（默认）；set=设置；clear=清除回默认。" },
        key: { type: "string", description: "规则名，如 nonIntrusive/remindGraceMinutes/remindTemplate。" },
        value: { type: ["string", "boolean", "number"], description: "规则值；字符串 true/false/数字会被转成对应类型。" },
      },
      output: {
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: {
          action: { type: "string" },
          policies: { type: "object" },
          result: { type: "object" },
        },
      },
      run: (args, exec) => {
        const agent = requireAgent(exec)
        const action = args.action ?? "list"
        if (action === "list") {
          return { action, policies: store.policiesAll() }
        }
        if (typeof args.key !== "string" || args.key.length === 0) {
          throw new Error("secretary_policy: " + action + " 需要 key")
        }
        if (!(args.key in POLICY_DEFAULTS)) {
          throw new Error("secretary_policy: 未知规则 key: " + args.key)
        }
        if (action === "clear") {
          const result = store.policyClear(args.key, { by: agent.id })
          return { action, result }
        }
        let value = args.value
        if (value === "true") value = true
        else if (value === "false") value = false
        else if (typeof value === "string" && value !== "" && Number.isFinite(Number(value))) value = Number(value)
        const result = store.policySet(args.key, value, { by: agent.id })
        return { action, result }
      },
    }),

    // =================================================================
    // 8/8 secretary_handoff —— 交接
    // =================================================================
    defineTool({
      name: "secretary_handoff",
      description: "交接：把未完任务打包转交给新接任者（状态 → handed_off 留痕，assignee 改派），"
        + "并默认经 conversation-link 把交接包发给接任人；send=false 只打包不发送。",
      parameters: {
        to: { type: "string", required: true, description: "接任人 handle 或 sessionId。" },
        from: { type: "string", description: "只交接该接收人的未完任务；缺省交接全部未完任务。" },
        taskIds: { type: "array", items: { type: "string" }, description: "显式指定任务号列表（优先于 from）。" },
        note: { type: "string", description: "交接备注。" },
        send: { type: "boolean", description: "false=只打包不发送；默认 true。" },
      },
      output: {
        type: "object",
        additionalProperties: false,
        required: ["moved", "package"],
        properties: {
          moved: { type: "array", items: { type: "object" } },
          package: { type: "object" },
          delivery: { type: "object" },
        },
      },
      run: async (args, exec) => {
        const agent = requireAgent(exec)
        const to = typeof args.to === "string" && args.to.length > 0 ? args.to : undefined
        if (to === undefined) throw new Error("secretary_handoff: 缺少接任人 to")
        let ids = []
        if (Array.isArray(args.taskIds) && args.taskIds.length > 0) {
          ids = args.taskIds.filter(x => typeof x === "string")
        } else {
          ids = store.tasksAll()
            .filter(t => {
              const belongs = typeof args.from === "string" && args.from.length > 0
                ? t.assignee === args.from
                : true
              return belongs && t.status !== "done" && t.status !== "cancelled" && t.status !== "handed_off"
            })
            .map(t => t.id)
        }
        if (ids.length === 0) {
          return { moved: [], package: { at: new Date().toISOString(), to, note: args.note ?? "", items: [] }, delivery: null }
        }
        const moved = store.taskHandoff(ids, to, { by: agent.id, note: args.note })
        const pkg = { at: new Date().toISOString(), from: agent.id, to, note: args.note ?? "", items: moved }
        if (args.send === false) {
          return { moved, package: pkg, delivery: { delivered: "deferred", reason: "send=false" } }
        }
        const message = composeHandoffMessage(pkg)
        const delivery = await transport.send({ target: to, message, mode: "inject", agent })
        return { moved, package: pkg, delivery }
      },
    }),
  ]
}
