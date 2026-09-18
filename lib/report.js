/**
 * 汇报生成：把多会话产出整理成结构化的主人汇报。
 *
 * 纯组装函数：入参 task 数组 + 状态口径，出参 summary + markdown。
 * 不读 IO、不调工具 —— 全部事实来自 store，方便测试与复用。
 *
 * @module dsh-secretary/report
 */

import { isOverdue, OPEN_STATUSES, TERMINAL_STATUSES } from './state.js'

/**
 * 生成汇报。
 * @param options.tasks   全部任务（store.tasksAll()）。
 * @param options.scope   open|all|overdue|done。
 * @param options.since   ISO 时间；只统计该时刻之后的动作（默认全量）。
 * @param options.now     当前时间（测试可注入）。
 * @returns { at, summary, sections, markdown }
 */
export function buildReport(options) {
  const now = options.now ?? Date.now()
  const since = typeof options.since === "string" && options.since.length > 0 ? Date.parse(options.since) : 0
  const scope = options.scope ?? "open"
  const at = new Date(now).toISOString()
  const tasks = Array.isArray(options.tasks) ? options.tasks : []

  const open = tasks.filter(t => OPEN_STATUSES.includes(t.status))
  const done = tasks.filter(t => t.status === "done" && (since === 0 || t.completedAt >= since))
  const overdue = open.filter(t => isOverdue(t, now))
  const cancelled = tasks.filter(t => t.status === "cancelled")
  const handedOff = tasks.filter(t => t.status === "handed_off")

  const visible =
    scope === "all" ? tasks
    : scope === "overdue" ? overdue
    : scope === "done" ? done
    : open

  // 按 assignee 分桶
  const perAssignee = new Map()
  for (const task of visible) {
    const bucket = perAssignee.get(task.assignee) ?? {
      assignee: task.assignee,
      open: 0,
      overdue: 0,
      done: 0,
      subjects: [],
    }
    if (task.status === "done") bucket.done += 1
    else {
      bucket.open += 1
      if (isOverdue(task, now)) bucket.overdue += 1
    }
    bucket.subjects.push({
      id: task.id,
      subject: task.subject,
      status: task.status,
      deadline: task.deadline,
      overdue: isOverdue(task, now),
      updatedAt: task.updatedAt,
    })
    perAssignee.set(task.assignee, bucket)
  }

  const summary = {
    at,
    scope,
    total: tasks.length,
    open: open.length,
    done: done.length,
    overdue: overdue.length,
    cancelled: cancelled.length,
    handedOff: handedOff.length,
    assigneeCount: perAssignee.size,
  }

  const sections = [...perAssignee.values()]
    .sort((a, b) => (b.overdue - a.overdue) || (b.open - a.open))
    .map(bucket => ({
      assignee: bucket.assignee,
      open: bucket.open,
      overdue: bucket.overdue,
      done: bucket.done,
      subjects: bucket.subjects.sort((a, b2) => {
        if (a.overdue !== b2.overdue) return a.overdue ? -1 : 1
        return (Date.parse(a.deadline) || 0) - (Date.parse(b2.deadline) || 0)
      }),
    }))

  const markdown = [
    "# 秘书汇报（" + scope + "）",
    "",
    "生成时间：" + at,
    "- " + summary.open + " 进行中 / " + summary.overdue + " 逾期 / " + summary.done + " 已完成（累计 " + summary.total + " 条任务）",
    "",
    "## 按执行会话",
    ...sections.flatMap(section => [
      "### " + section.assignee + "（进行中 " + section.open + "，逾期 " + section.overdue + "，已完成 " + section.done + "）",
      ...section.subjects.map(task =>
        "- " + (task.overdue ? "⚠️ 逾期" : "·") + " [" + task.id + "] " + task.subject
          + (task.deadline ? "（截止 " + task.deadline + "）" : "")
      ),
    ]),
  ].join("\n")

  return { at, summary, sections, markdown }
}
