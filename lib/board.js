/**
 * 进度看板：把「每个会话正在干什么」聚合成一张概要表。
 *
 * 数据源（全部由 conversation-link 提供，本插件只读不写）：
 *   conversation_list     —— 可寻址会话集合（handle/title/cwd/status/live）
 *   conversation_status  —— 每个会话的实时进度（当前 step、最近消息、待处理）
 * 叠加层：store.roster 的「职责 / 当前任务」名片，task 的逾期标记。
 *
 * 失败口径：任一会话状态读不到就标 unavailable，不阻断整板 —— 看板是信息面板，
 * 不是调度硬依赖。
 *
 * @module dsh-secretary/board
 */

/** 从 host 工具执行结果里提取 JSON 对象（工具结果可能是 { content:[text] } 包装）。 */
function unwrapObject(result) {
  if (result === undefined || result === null) return undefined
  if (typeof result === "object" && !Array.isArray(result)) return result
  return undefined
}

/**
 * 聚合看板。
 * @param ctx      host 上下文。
 * @param store    StateStore（叠加 roster 名片与逾期标记）。
 * @param options.scope  conversation_list 的作用域（workspace|all），默认取 policy。
 * @param options.agent  调用方 agent。
 * @returns { at, scope, entries, unreachable }
 */
export async function collectBoard(ctx, store, options = {}) {
  const tools = ctx.get("tools")
  const agent = options.agent
  const scope = options.scope ?? store.policy("boardScope")
  const at = new Date().toISOString()
  const entries = []
  const unreachable = []

  // 1) 会话清单：conversation_list
  let peers = []
  try {
    const listed = await tools.execute({ name: "conversation_list", agent, arguments: { scope } })
    const data = unwrapObject(listed) ?? {}
    const conversations = Array.isArray(data.conversations) ? data.conversations : []
    const links = Array.isArray(data.links) ? data.links : []
    // 合并：先 workspace 会话，再用链接补昵称
    const bySession = new Map()
    for (const item of conversations) bySession.set(String(item.sessionId), { ...item, origin: "workspace" })
    for (const item of links) {
      const id = String(item.sessionId)
      const previous = bySession.get(id) ?? { sessionId: id }
      bySession.set(id, { ...previous, ...item, origin: previous.origin ?? "link" })
    }
    peers = [...bySession.values()]
  } catch (error) {
    peers = []
    unreachable.push({ source: "conversation_list", error: String(error) })
  }

  // 2) 逐个会话拉实时状态：conversation_status
  const now = Date.now()
  const tasks = store.tasksAll()
  for (const peer of peers) {
    const sessionId = String(peer.sessionId ?? "")
    const key = typeof peer.name === "string" && peer.name.length > 0 ? peer.name : peer.handle ?? sessionId
    const card = store.rosterGet(key) ?? store.rosterBySession(sessionId)
    const openTasks = tasks.filter(t => t.assignee === key || t.assignee === sessionId)
    const entry = {
      sessionId,
      handle: peer.handle ?? key,
      name: peer.name ?? key,
      title: peer.title ?? "",
      cwd: peer.cwd ?? "",
      live: peer.live === true,
      status: card?.status ?? peer.status ?? "unknown",
      role: card?.role ?? "",
      currentTask: card?.currentTask ?? (openTasks[0] ? openTasks[0].subject : ""),
      openTaskCount: openTasks.length,
      overdueCount: openTasks.filter(t => {
        const deadline = Date.parse(t.deadline)
        return Number.isFinite(deadline) && deadline < now
          && t.status !== "done" && t.status !== "cancelled" && t.status !== "handed_off"
      }).length,
      progress: null, // TODO(phase-2): conversation_status 归一化后填这里
    }
    try {
      const status = await tools.execute({
        name: "conversation_status",
        agent,
        arguments: { target: entry.handle, recent: 2 },
      })
      const data = unwrapObject(status) ?? {}
      entry.progress = {
        turn: data.turn ?? null,
        step: data.step ?? null,
        pending: data.pending ?? 0,
        lastAssistantText: typeof data.lastAssistantText === "string"
          ? data.lastAssistantText.slice(0, 120)
          : "",
      }
    } catch (error) {
      unreachable.push({ source: "conversation_status", target: entry.handle, error: String(error) })
    }
    entries.push(entry)
  }

  return { at, scope, entries, unreachable }
}
