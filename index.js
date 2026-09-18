/**
 * dsh-secretary：调度状态机 + 信息面板。
 *
 * 定位：不替代 conversation-link。秘书只做三件事 —— 记录（roster/tasks/policies）、
 * 转发（所有消息经 transport 走 conversation-link 的 conversation_send）、
 * 汇报（board/report 读 conversation-link 的只读接口聚合）。决定权始终在各会话与主人。
 *
 * 挂载即生效：
 *   - 注册 8 个 secretary_* 工具（模型在任意会话里都能用）；
 *   - 订阅 conversation/deleted，删除会话时清理台账名片；
 *   - 在 $DSH_HOME/secretary/ 写 mount.json 诊断记录（区别于业务 state.json）。
 *
 * @module dsh-secretary
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { StateStore, isOverdue } from './lib/state.js'
import { createTools } from './lib/tools.js'

/** Cordis 插件名。 */
export const name = "secretary"

/** 挂载前必需的服务：工具注册表（注册 8 个工具）、agent 注册表（会话身份）。 */
export const inject = ["tools", "agents", "connection"]

/** 展开路径开头的 ~/。 */
function expandHome(value) {
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value
}

/**
 * 解析状态文件路径：config.stateDir 优先，缺省 $DSH_HOME/secretary/state.json。
 * @param config - 插件配置。
 * @returns 状态文件绝对路径。
 */
export function resolveStateFile(config) {
  if (typeof config.stateDir === "string" && config.stateDir.length > 0) {
    return join(expandHome(config.stateDir), "state.json")
  }
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), ".dsh")
  return join(home, "secretary", "state.json")
}

/**
 * 挂载成功后在秘书状态目录写 mount.json（与业务 state.json 分开；
 * 只写一次，供 shell 侧确认「已挂载且工具全被宿主接受」）。
 */
function recordMount(stateFile, toolCount) {
  try {
    mkdirSync(dirname(stateFile), { recursive: true })
    writeFileSync(join(dirname(stateFile), "mount.json"), JSON.stringify({
      mountedAt: new Date().toISOString(),
      pid: process.pid,
      node: process.version,
      tools: toolCount,
      plugin: "dsh-secretary",
      state: stateFile,
    }, null, 2) + "\n", "utf8")
  } catch {
    // 诊断写入不得导致挂载失败
  }
}

/**
 * 挂载插件。
 * @param ctx    - host 上下文。
 * @param config - cordis.patch.yml 的 config 段。
 */
export function apply(ctx, config = {}) {
  const stateFile = resolveStateFile(config)
  const logger = ctx.get("logger")
  const store = new StateStore({ file: stateFile, logger })
  // 触达一次存储：文件损坏/版本不符在挂载时就告警，而不是等第一次工具调用
  try {
    store.tasksAll()
  } catch (error) {
    logger?.warn?.("dsh-secretary: 状态加载异常 " + String(error))
  }

  const definitions = createTools(ctx, store)
  for (const definition of definitions) {
    ctx.tools.register(definition)
  }

  // 浏览器端信息面板的数据/操作端点（web client 经 fetch 调用）：
  //   GET/POST /api/secretary/<endpoint>  （overview | bind | unbind）
  // 挂载姿势与 dsh-tool-session 的 switch-events 相同：
  //   ctx.inject(['connection']) 等待 connection 服务激活后再注册（apply 时可能未就绪），
  //   connection.fetch.register 挂精确路由（/api 前缀，在浏览器认证管道内）。
  const endpoints = {
    overview: (args) => {
      const tasks = store.tasksAll()
      const now = Date.now()
      const open = tasks.filter(t => t.status === 'dispatched' || t.status === 'received' || t.status === 'pending_accept')
      return {
        binding: store.bindingGet() ?? null,
        mountedAt: store.file,
        rosterCount: store.rosterAll().length,
        taskStats: {
          total: tasks.length,
          open: open.length,
          overdue: open.filter(t => isOverdue(t, now)).length,
          done: tasks.filter(t => t.status === 'done').length,
          cancelled: tasks.filter(t => t.status === 'cancelled').length,
          handedOff: tasks.filter(t => t.status === 'handed_off').length,
        },
        overdueTop: open
          .filter(t => isOverdue(t, now))
          .sort((a, b) => (Date.parse(a.deadline) || 0) - (Date.parse(b.deadline) || 0))
          .slice(0, 10)
          .map(t => ({ id: t.id, subject: t.subject, assignee: t.assignee, deadline: t.deadline })),
        policies: store.policiesAll(),
        outboxCount: store.outboxAll().length,
        stateFile: store.file,
      }
    },
    bind: (args) => {
      const value = store.bindingSet({ target: args.target, name: args.name }, { by: 'client' })
      if (value === undefined) throw new Error('缺少 target（handle 或 sessionId）')
      return value
    },
    unbind: () => {
      store.bindingClear({ by: 'client' })
      return null
    },
  }
  const registerRpc = (connection, connCtx) => {
    const register = connection?.fetch?.register
    if (typeof register !== 'function') {
      logger?.warn?.('dsh-secretary: connection.fetch.register 不可用，信息面板将不可用（工具不受影响）')
      return
    }
    for (const [name, fn] of Object.entries(endpoints)) {
      const path = '/api/secretary/' + name
      const route = {
        path,
        methods: ['POST'],
        fetch: async (request) => {
          let rpcId = undefined
          let envelope = undefined
          try {
            const body = await request?.json?.().catch?.(() => ({})) ?? {}
            rpcId = body.rpcId
            const args = (body.payload && body.payload.args) || {}
            const value = fn(args)
            envelope = { type: 'server-response', rpcId, result: { ok: true, value } }
          } catch (error) {
            logger?.warn?.('dsh-secretary: ' + path + ' 处理失败: ' + String(error))
            envelope = { type: 'server-response', rpcId, result: { ok: false, error: { message: String(error?.message || error) } } }
          }
          return Response.json(envelope)
        },
      }
      connCtx.effect(() => {
        const dispose = register(route)
        logger?.info?.('dsh-secretary: ' + path + ' mounted')
        return () => { try { dispose?.() } catch {} }
      }, 'dsh-secretary: ' + path + ' route')
    }
  }
  const waitConnection = (ctx, cb) => {
    const connection = ctx.get('connection')
    if (typeof connection?.fetch?.register === 'function') { cb(connection, ctx) }
    else { logger?.warn?.('dsh-secretary: connection 未就绪于 apply 时刻') }
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['connection'], (connCtx) => {
      const connection = connCtx.get('connection')
      if (connection === undefined) { logger?.warn?.('dsh-secretary: connection 服务缺失，跳过 RPC 挂载') ; return }
      registerRpc(connection, connCtx)
    })
  } else {
    waitConnection(ctx, registerRpc)
  }


  // 会话被删除 → 清理台账名片（与 conversation-link 忘掉链接同一时机）
  try {
    ctx.on("conversation/deleted", (sessionId) => {
      try {
        const removed = store.forgetSession(String(sessionId))
        if (removed > 0) {
          store.audit({ event: "roster.forget-deleted", by: "host", detail: String(sessionId) })
        }
      } catch (error) {
        logger?.warn?.("dsh-secretary: 清理已删会话名片失败 " + String(error))
      }
    })
  } catch (error) {
    logger?.warn?.("dsh-secretary: 无法订阅 conversation/deleted: " + String(error))
  }

  if (typeof config.mountLog === "string" && config.mountLog.length > 0) {
    try {
      appendFileSync(config.mountLog, new Date().toISOString()
        + " mounted pid=" + process.pid + " state=" + stateFile + " tools=" + definitions.length + "\n")
    } catch {
      // 诊断写入不得导致挂载失败
    }
  }
  recordMount(stateFile, definitions.length)
}