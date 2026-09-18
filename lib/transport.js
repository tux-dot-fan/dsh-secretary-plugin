/**
 * 通信接缝：秘书的「转发」唯一出口。
 *
 * 设计红线：不替代 conversation-link。本模块绝不自己实现消息框架/投递，
 * 而是通过 host 的 tools 服务**程序化调用已注册的 conversation_send 工具**
 * （tools.execute 与模型直接调用走同一条 pre/post-execute 策略管线，因此
 * 秘书发的消息一样被 conversation-link 的规则护栏覆盖）。
 *
 * 降级：conversation-link 未安装或调用失败时，fail-open —— 把消息落进
 * state.outbox（deferred 模式），由主人/模型后续补发；秘书只负责留痕。
 *
 * @module dsh-secretary/transport
 */

/** 安全探测一个可选服务（cordis 的 proxy 直接读属性会抛错）。 */
function optional(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}


/**
 * 从 host 工具执行结果里提取可读文本（防御各异构）。
 * result 的形状：tools.execute 返回 materialized 快照，content 为块数组或字符串。
 */
function unwrapText(result) {
  if (result === undefined || result === null) return ""
  if (typeof result === "string") return result
  const content = result.content
  if (Array.isArray(content)) {
    return content
      .filter(block => typeof block === "object" && block !== null && block.type === "text")
      .map(block => (typeof block.text === "string" ? block.text : ""))
      .join("\n")
  }
  if (typeof content === "string") return content
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return ""
  }
}

/** 是否命中「工具未注册」类错误。 */
function isUnknownTool(errorOrText) {
  const text = typeof errorOrText === "string" ? errorOrText : unwrapText(errorOrText)
  return /UNKNOWN_TOOL|unknown tool|not registered/i.test(text)
}

/**
 * 构建秘书的通信接缝。
 * @param ctx    host 上下文（经 ctx.get("tools") 取工具服务）。
 * @param store  StateStore（outbox 落袋）。
 * @returns { supportsSend, send }
 */
export function createTransport(ctx, store) {
  return {
    /**
     * conversation_send 是否已在本组合注册（即 conversation-link 已挂载）。
     */
    supportsSend(agent) {
      const tools = optional(ctx, "tools")
      if (tools === undefined || typeof tools.get !== "function") return false
      try {
        return tools.get("conversation_send", agent) !== undefined
      } catch {
        return false
      }
    },

    /**
     * 经 conversation-link 送一条消息。
     * @param options.target  会话 handle / sessionId。
     * @param options.message 正文。
     * @param options.mode    conversation_send 的投递模式（auto|queue|steer|inject）。
     * @param options.agent   调用方 agent（secretary 在被哪个会话里执行，就带着它的身份）。
     * @returns { delivered: "sent"|"deferred"|"failed", result?, reason? }
     */
    async send({ target, message, mode = "inject", agent }) {
      const tools = optional(ctx, "tools")
      if (tools === undefined || typeof tools.execute !== "function") {
        store.outboxPush({ kind: "send", target, message, mode, reason: "no-tools-service" })
        return { delivered: "deferred", reason: "no-tools-service" }
      }
      try {
        const result = await tools.execute({
          name: "conversation_send",
          agent,
          arguments: { target, message, mode },
        })
        const text = unwrapText(result)
        if (result?.isError === true || /error/i.test(text.slice(0, 200))) {
          if (isUnknownTool(text)) {
            store.outboxPush({ kind: "send", target, message, mode, reason: "conversation-link-not-installed" })
            return { delivered: "deferred", reason: "conversation-link-not-installed" }
          }
          return { delivered: "failed", reason: text }
        }
        store.outboxPush({ kind: "sent-receipt", target, message, mode, result: text.slice(0, 500) })
        return { delivered: "sent", result: text }
      } catch (error) {
        // fail-open：调度状态机永远不能被通信故障打断
        store.outboxPush({ kind: "send", target, message, mode, reason: String(error) })
        return { delivered: "failed", reason: String(error) }
      }
    },
  }
}
