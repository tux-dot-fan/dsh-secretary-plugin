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
import { StateStore } from './lib/state.js'
import { createTools } from './lib/tools.js'

/** Cordis 插件名。 */
export const name = "secretary"

/** 挂载前必需的服务：工具注册表（注册 8 个工具）、agent 注册表（会话身份）。 */
export const inject = ["tools", "agents"]

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
