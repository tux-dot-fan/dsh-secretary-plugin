/**
 * dsh-secretary 的持久化状态存储。
 *
 * 这是「调度状态机」的地基：一处 versioned JSON 文件（默认
 * $DSH_HOME/secretary/state.json），保存三类事实 ——
 *   roster   会话台账（名片簿：handle/昵称/职责/当前任务/状态/cwd）
 *   tasks    任务记录（委派跟踪的唯一事实源）
 *   policies 秘书自己的行为规则（催办宽限、不打扰开关、模板等）
 * 外加两条派生数据：
 *   audit    审计环（派发/催办/汇报全部留痕，有界环形缓冲）
 *   outbox   待送达消息（transport 降级到 deferred 模式时的落袋处）
 *
 * 写入约定：整份状态序列化后先写 <file>.tmp 再 rename，崩溃不会暴露半截文件，
 * 与 dsh-conversation-link 的 store 同一约定。
 *
 * 状态机（任务生命周期）：
 *   dispatched -> received -> pending_accept -> done
 *   dispatched/received/pending_accept -> cancelled | handed_off
 *   overdue 是派生状态，不落盘：deadline 已过且未终结。
 *
 * @module dsh-secretary/state
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 磁盘状态版本；升级形状时 +1 并提供迁移。 */
export const STATE_VERSION = 1

/** 任务未终结状态（构成「进行中」集合）。 */
export const OPEN_STATUSES = Object.freeze(['dispatched', 'received', 'pending_accept'])

/** 任务可迁移的终结状态。 */
export const TERMINAL_STATUSES = Object.freeze(['done', 'cancelled', 'handed_off'])

/** 任务状态全集。 */
export const TASK_STATUSES = Object.freeze([...OPEN_STATUSES, ...TERMINAL_STATUSES])

/** 优先级枚举。 */
export const PRIORITIES = Object.freeze(['low', 'normal', 'high', 'urgent'])

/** 行为规则默认值；policy 未显式设置时按此生效。 */
export const POLICY_DEFAULTS = Object.freeze({
  nonIntrusive: true,          // 催办默认不打扰
  remindGraceMinutes: 60,      // 截止后宽限分钟数
  remindTemplate: '催办提醒：任务「{subject}」截止 {deadline}，已逾期 {overdue}，请更新进展。',
  remindMaxPerTask: 3,         // 单任务催办次数上限（防止骚扰）
  boardScope: 'workspace',     // 看板默认作用域
  reportDefaultScope: 'open',  // 汇报默认范围：open | all | overdue | done
  auditLimit: 500,             // 审计环上限
})

/** 生成短任务 id；进程内自增保证同毫秒不撞。 */
export function mintTaskId(now = Date.now()) {
  const seq = (mintTaskId.seq = (mintTaskId.seq ?? 0) + 1)
  return "S-" + now.toString(36).toUpperCase() + "-" + seq
}

/** 任务是否已逾期（deadline 过去且未终结）。 */
export function isOverdue(task, now = Date.now()) {
  if (task === undefined || task === null) return false
  if (typeof task.deadline === "string" && task.deadline.length > 0) {
    const deadline = Date.parse(task.deadline)
    if (Number.isFinite(deadline) && deadline < now && !TERMINAL_STATUSES.includes(task.status)) {
      return true
    }
  }
  return false
}

/** 以「已派/已收/待验收/逾期」口径整理一条任务的展示状态。 */
export function collectTaskStatus(task, now = Date.now()) {
  if (task === undefined || task === null) return "unknown"
  if (isOverdue(task, now)) return "overdue"
  return task.status
}

/** 归一化一条存储里的原始任务记录；不可用的丢弃。 */
export function normalizeTask(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const id = typeof value.id === "string" && value.id.length > 0 ? value.id : undefined
  const subject = typeof value.subject === "string" && value.subject.length > 0 ? value.subject : undefined
  const assignee = typeof value.assignee === "string" && value.assignee.length > 0 ? value.assignee : undefined
  if (id === undefined || subject === undefined || assignee === undefined) return undefined
  return {
    id,
    subject,
    assignee,
    sender: typeof value.sender === "string" ? value.sender : "",
    status: TASK_STATUSES.includes(value.status) ? value.status : "dispatched",
    sent: value.sent === true,
    deadline: typeof value.deadline === "string" ? value.deadline : "",
    priority: PRIORITIES.includes(value.priority) ? value.priority : "normal",
    note: typeof value.note === "string" ? value.note : "",
    dispatchedAt: Number(value.dispatchedAt) || 0,
    receivedAt: Number(value.receivedAt) || 0,
    acceptedAt: Number(value.acceptedAt) || 0,
    completedAt: Number(value.completedAt) || 0,
    cancelledAt: Number(value.cancelledAt) || 0,
    handedOffAt: Number(value.handedOffAt) || 0,
    remindedAt: Number(value.remindedAt) || 0,
    handoffNote: typeof value.handoffNote === "string" ? value.handoffNote : "",
    reminders: Array.isArray(value.reminders) ? value.reminders.filter(x2 => typeof x2 === "object" && x2 !== null) : [],
    updatedAt: Number(value.updatedAt) || Number(value.dispatchedAt) || 0,
  }
}

/**
 * 归一化「秘书会话绑定」；不可用的丢弃。
 * binding 是面板跳转入口的目标：用户可以指定某个会话作为「秘书会话」。
 */
export function normalizeBinding(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const target = typeof value.target === "string" && value.target.length > 0 ? value.target : undefined
  if (target === undefined) return undefined
  return {
    target,
    name: typeof value.name === "string" ? value.name : "",
    updatedAt: Number(value.updatedAt) || 0,
  }
}

/** 归一化一条台账记录；不可用的丢弃。 */
export function normalizeRosterEntry(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const key = typeof value.key === "string" && value.key.length > 0 ? value.key : undefined
  if (key === undefined) return undefined
  return {
    key,
    sessionId: typeof value.sessionId === "string" ? value.sessionId : "",
    nickname: typeof value.nickname === "string" ? value.nickname : key,
    role: typeof value.role === "string" ? value.role : "",
    status: typeof value.status === "string" ? value.status : "",
    cwd: typeof value.cwd === "string" ? value.cwd : "",
    currentTask: typeof value.currentTask === "string" ? value.currentTask : "",
    note: typeof value.note === "string" ? value.note : "",
    updatedAt: Number(value.updatedAt) || 0,
  }
}

/** 有界环：追加一条审计记录，超出上限丢弃最旧。 */
function pushBounded(list, entry, limit) {
  list.push(entry)
  if (list.length > limit) list.splice(0, list.length - limit)
}

/**
 * 全部持久化事实的读写器。
 *
 * 所有读取走内存缓存（mount 时一次性载入），所有变更走 write() 原子落盘 ——
 * 单文件、整写、可审计。这是「调度状态机」可靠性的底线。
 */
export class StateStore {
  #file
  #logger
  #state
  #loaded = false

  /**
   * @param options.file      状态文件绝对路径。
   * @param options.logger    可选诊断 sink（ctx.get("logger")）。
   */
  constructor({ file, logger }) {
    this.#file = file
    this.#logger = logger
  }

  /** 状态文件绝对路径（诊断与审计用）。 */
  get file() {
    return this.#file
  }

  /** 读一次，容忍缺失/损坏文件，全部归一化。 */
  #read() {
    if (this.#loaded) return this.#state
    this.#loaded = true
    this.#state = {
      version: STATE_VERSION,
      roster: {},
      tasks: {},
      policies: {},
      binding: undefined,
      audit: [],
      outbox: [],
    }
    let raw
    try {
      raw = readFileSync(this.#file, "utf8")
    } catch {
      return this.#state // 首次运行没有状态文件
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      return this.#state
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return this.#state
    }
    if (parsed.version !== STATE_VERSION) {
      return this.#state
    }
    const rawRoster = typeof parsed.roster === "object" && parsed.roster !== null && !Array.isArray(parsed.roster)
      ? parsed.roster
      : {}
    const roster = {}
    for (const entry of Object.values(rawRoster)) {
      const normal = normalizeRosterEntry(entry)
      if (normal !== undefined) roster[normal.key] = normal
    }
    const rawTasks = typeof parsed.tasks === "object" && parsed.tasks !== null && !Array.isArray(parsed.tasks)
      ? parsed.tasks
      : {}
    const tasks = {}
    for (const entry of Object.values(rawTasks)) {
      const normal = normalizeTask(entry)
      if (normal !== undefined) tasks[normal.id] = normal
    }
    this.#state = {
      version: STATE_VERSION,
      roster,
      tasks,
      policies: typeof parsed.policies === "object" && parsed.policies !== null && !Array.isArray(parsed.policies)
        ? { ...parsed.policies }
        : {},
      binding: normalizeBinding(parsed.binding),
      audit: Array.isArray(parsed.audit) ? parsed.audit.slice(-POLICY_DEFAULTS.auditLimit) : [],
      outbox: Array.isArray(parsed.outbox) ? parsed.outbox.slice(-100) : [],
    }
    return this.#state
  }

  /** 整份状态原子落盘；失败只告警不抛出。 */
  write() {
    const state = this.#read()
    const temporary = this.#file + ".tmp"
    try {
      mkdirSync(dirname(this.#file), { recursive: true })
      writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", "utf8")
      renameSync(temporary, this.#file)
    } catch (error) {
      // 存储错误不得打穿工具调用
    }
  }

  /** 追加审计记录并立即落盘。 */
  audit({ event, by, taskId, detail }) {
    const state = this.#read()
    const limit = this.policy("auditLimit")
    pushBounded(state.audit, {
      at: new Date().toISOString(),
      event,
      by: typeof by === "string" ? by : "",
      taskId: typeof taskId === "string" ? taskId : undefined,
      detail: typeof detail === "string" ? detail : "",
    }, limit)
    this.write()
  }

  /** 最近 N 条审计（新在前）。 */
  recentAudit(limit = 50) {
    return [...this.#read().audit].reverse().slice(0, limit)
  }

  // ---------------------------------------------------------------------
  // roster（会话台账）
  // ---------------------------------------------------------------------

  /** 全部台账条目（拷贝）。 */
  rosterAll() {
    return Object.values(this.#read().roster).map(entry => ({ ...entry }))
  }

  /** 取一条台账；key 为 handle 或 sessionId。 */
  rosterGet(key) {
    const state = this.#read()
    return state.roster[key] === undefined ? undefined : { ...state.roster[key] }
  }

  /** 按 sessionId 反查台账。 */
  rosterBySession(sessionId) {
    const state = this.#read()
    for (const entry of Object.values(state.roster)) {
      if (entry.sessionId === sessionId) return { ...entry }
    }
    return undefined
  }

  /** 新增或更新一张名片；key 用 handle（可说出口的名字）。 */
  rosterUpsert(key, patch, logger) {
    const state = this.#read()
    const previous = state.roster[key]
    const next = normalizeRosterEntry({
      ...(previous ?? { key }),
      key,
      ...patch,
      updatedAt: Date.now(),
    })
    if (next === undefined) {
      logger?.warn?.(`dsh-secretary: 非法的台账 key "${String(key)}"，拒绝写入`)
      return undefined
    }
    state.roster[key] = next
    this.write()
    return { ...next }
  }

  /** 移除一张名片。 */
  rosterRemove(key) {
    const state = this.#read()
    const removed = state.roster[key]
    if (removed === undefined) return undefined
    delete state.roster[key]
    this.write()
    return { ...removed }
  }

  /** 会话被删除时清理其台账名片（订阅 conversation/deleted）。 */
  forgetSession(sessionId) {
    const state = this.#read()
    let removed = 0
    for (const [key, entry] of Object.entries(state.roster)) {
      if (entry.sessionId === sessionId) {
        delete state.roster[key]
        removed += 1
      }
    }
    if (removed > 0) this.write()
    return removed
  }

  // ---------------------------------------------------------------------
  // tasks（任务记录）
  // ---------------------------------------------------------------------

  /** 全部任务（拷贝）。 */
  tasksAll() {
    return Object.values(this.#read().tasks).map(task => ({ ...task }))
  }

  /** 取一条任务。 */
  taskGet(id) {
    const state = this.#read()
    return state.tasks[id] === undefined ? undefined : { ...state.tasks[id] }
  }

  /** 新建任务：默认 dispatched，立即落盘并写审计。 */
  taskCreate(fields, { by }) {
    const state = this.#read()
    const task = normalizeTask({
      id: mintTaskId(),
      subject: fields.subject,
      assignee: fields.assignee,
      sender: fields.sender ?? by ?? "",
      status: "dispatched",
      sent: fields.sent === true,
      deadline: fields.deadline ?? "",
      priority: fields.priority ?? "normal",
      note: fields.note ?? "",
      dispatchedAt: Date.now(),
      updatedAt: Date.now(),
    })
    if (task === undefined) throw new Error("secretary_assign: 任务缺少 subject 或 assignee")
    state.tasks[task.id] = task
    this.write()
    this.audit({ event: "task.dispatched", by, taskId: task.id, detail: task.assignee + ": " + task.subject })
    return { ...task }
  }

  /** 更新任务字段（不做状态合法性检查，由调用方保证）。 */
  taskUpdate(id, patch, { by }) {
    const state = this.#read()
    const current = state.tasks[id]
    if (current === undefined) return undefined
    const before = { ...current }
    const next = normalizeTask({ ...current, ...patch, updatedAt: Date.now() })
    if (next === undefined) return undefined
    state.tasks[id] = next
    this.write()
    if (before.status !== next.status) {
      this.audit({ event: "task.status:" + before.status + "->" + next.status, by, taskId: id, detail: next.subject })
    }
    return { ...next, _before: before.status }
  }

  /** 任务状态迁移（含合法性：终结态不可再迁移）。 */
  taskTransition(id, to, { by }) {
    const state = this.#read()
    const current = state.tasks[id]
    if (current === undefined) return undefined
    if (TERMINAL_STATUSES.includes(current.status) && current.status !== to) {
      throw new Error("secretary: 任务 " + id + " 已是终结态 " + current.status + "，不可迁往 " + to)
    }
    const stamps = {
      received: { receivedAt: Date.now() },
      pending_accept: { acceptedAt: Date.now() },
      done: { completedAt: Date.now() },
      cancelled: { cancelledAt: Date.now() },
      handed_off: { handedOffAt: Date.now() },
    }
    return this.taskUpdate(id, { status: to, ...(stamps[to] ?? {}) }, { by })
  }

  /** 记录一次催办（reminders 留痕，remindedAt 推进）。 */
  taskRemind(id, { by, mode, detail }) {
    const state = this.#read()
    const current = state.tasks[id]
    if (current === undefined) return undefined
    const next = normalizeTask({
      ...current,
      remindedAt: Date.now(),
      reminders: [...current.reminders, {
        at: new Date().toISOString(),
        by: typeof by === "string" ? by : "",
        mode: typeof mode === "string" ? mode : "dry-run",
        detail: typeof detail === "string" ? detail : "",
      }],
      updatedAt: Date.now(),
    })
    state.tasks[id] = next
    this.write()
    this.audit({ event: "task.reminded", by, taskId: id, detail: mode })
    return { ...next }
  }

  /**
   * 交接：把一组任务改派给新 assignee，旧任务状态 → handed_off（终结留痕），
   * 写 handoffNote；返回交接摘要供 secretary_handoff 打包给新接任者。
   */
  taskHandoff(taskIds, to, { by, note }) {
    const state = this.#read()
    const moved = []
    for (const id of taskIds) {
      const current = state.tasks[id]
      if (current === undefined) continue
      if (TERMINAL_STATUSES.includes(current.status)) continue // 已终结的不转
      const next = normalizeTask({
        ...current,
        status: "handed_off",
        handedOffAt: Date.now(),
        handoffNote: typeof note === "string" ? note : current.handoffNote,
        previousAssignee: current.assignee,
        assignee: to,
        updatedAt: Date.now(),
      })
      state.tasks[id] = next
      moved.push({ id, subject: next.subject, from: current.assignee, to })
    }
    if (moved.length > 0) {
      this.write()
      this.audit({ event: "task.handoff", by, detail: moved.length + " 项任务移交 " + to })
    }
    return moved
  }

  // ---------------------------------------------------------------------
  // binding（秘书会话绑定）
  // ---------------------------------------------------------------------

  /** 当前绑定的秘书会话；未绑定时为 undefined。 */
  bindingGet() {
    const state = this.#read()
    return state.binding === undefined ? undefined : { ...state.binding }
  }

  /** 绑定/改绑秘书会话（target 为 handle 或 sessionId），写审计。 */
  bindingSet({ target, name }, { by }) {
    const state = this.#read()
    const next = normalizeBinding({ target, name, updatedAt: Date.now() })
    if (next === undefined) return undefined
    state.binding = next
    this.write()
    this.audit({ event: "secretary.bound", by, detail: target + (name ? "（" + name + "）" : "") })
    return { ...next }
  }

  /** 解绑。 */
  bindingClear({ by }) {
    const state = this.#read()
    if (state.binding === undefined) return undefined
    const previous = state.binding
    state.binding = undefined
    this.write()
    this.audit({ event: "secretary.unbound", by, detail: previous.target })
    return { ...previous }
  }

  // ---------------------------------------------------------------------
  // policies（行为规则）
  // ---------------------------------------------------------------------

  /** 读取一条规则（无则用默认值）。 */
  policy(key) {
    const state = this.#read()
    const value = state.policies[key]
    return value === undefined ? POLICY_DEFAULTS[key] : value
  }

  /** 全部生效规则（默认值合并，便于 secretary_policy 展示）。 */
  policiesAll() {
    return { ...POLICY_DEFAULTS, ...this.#read().policies }
  }

  /** 设置一条规则（与默认一致时归零，保持文件干净）。 */
  policySet(key, value, { by }) {
    const state = this.#read()
    const before = this.policy(key)
    const serialized = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)
    if (state.policies[key] !== undefined && POLICY_DEFAULTS[key] !== undefined
      && String(POLICY_DEFAULTS[key]) === serialized) {
      delete state.policies[key]
    } else {
      state.policies[key] = value
    }
    this.write()
    this.audit({ event: "policy.set", by, detail: key + " = " + serialized + "（原 " + String(before) + "）" })
    return { key, value: this.policy(key) }
  }

  /** 清除一条规则（回到默认）。 */
  policyClear(key, { by }) {
    const state = this.#read()
    const before = this.policy(key)
    delete state.policies[key]
    this.write()
    this.audit({ event: "policy.clear", by, detail: key + "（原 " + String(before) + "）" })
    return { key, value: this.policy(key) }
  }

  // ---------------------------------------------------------------------
  // outbox（deferred 送达兜底）
  // ---------------------------------------------------------------------

  /** 追加一条待送达消息（transport 不可用时落袋，供主人/模型后续补发）。 */
  outboxPush(entry) {
    const state = this.#read()
    state.outbox.push({ ...entry, at: new Date().toISOString() })
    this.write()
    return state.outbox.length
  }

  /** 待送达队列（拷贝）。 */
  outboxAll() {
    return [...this.#read().outbox]
  }
}