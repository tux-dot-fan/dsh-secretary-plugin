/**
 * 调度计算：逾期判定与催办候选。纯函数，不碰 IO；
 * 「何时催」的唯一口径在这里，secretary_remind / 后台 tick 共用。
 *
 * 口径：deadline 已过 + 超过 policy.remindGraceMinutes 宽限 + 未终结
 *       + 单任务催办次数未达 policy.remindMaxPerTask 上限。
 *
 * @module dsh-secretary/schedule
 */

import { isOverdue, OPEN_STATUSES } from './state.js'

/**
 * 收集当前「该催」的任务候选。
 * @param tasks     任务数组（store.tasksAll() 的拷贝即可）。
 * @param options.now              当前时间（测试可注入）。
 * @param options.graceMs          宽限毫秒数（默认 0，调用方传 policy）。
 * @param options.maxPerTask       单任务催办次数上限（默认 Infinity）。
 * @param options.includeJustLate  是否包含「已逾期但未达宽限」的条目（默认 false）。
 * @returns [{ task, overdueMs, due }]，按 deadline 升序。
 */
export function collectDueTasks(tasks, options = {}) {
  const now = options.now ?? Date.now()
  const graceMs = Number(options.graceMs) || 0
  const maxPerTask = Number(options.maxPerTask) || Number.POSITIVE_INFINITY
  const includeJustLate = options.includeJustLate === true
  const due = []
  for (const task of tasks) {
    if (!OPEN_STATUSES.includes(task.status)) continue
    if (!isOverdue(task, now)) continue
    const deadlineMs = Date.parse(task.deadline)
    const overdueMs = Number.isFinite(deadlineMs) ? now - deadlineMs : 0
    const beyondGrace = overdueMs >= graceMs
    if (!beyondGrace && !includeJustLate) continue
    if (task.reminders.length >= maxPerTask) continue
    due.push({ task, overdueMs, due: beyondGrace })
  }
  due.sort((a, b) => (Date.parse(a.task.deadline) || 0) - (Date.parse(b.task.deadline) || 0))
  return due
}

/**
 * 把“已逾期多久”格式化成给人看的中文（x 分钟 / x 小时 / x 天）。
 */
export function humanizeDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "刚刚"
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return minutes + " 分钟"
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + " 小时"
  const days = Math.floor(hours / 24)
  return days + " 天"
}

/**
 * 用模板渲染催办文案（{subject}/{deadline}/{overdue}/{assignee} 占位符）。
 */
export function renderTemplate(template, task, now = Date.now()) {
  const overdueMs = Date.parse(task.deadline)
  return template
    .replaceAll("{subject}", task.subject)
    .replaceAll("{assignee}", task.assignee)
    .replaceAll("{deadline}", task.deadline || "（未设截止）")
    .replaceAll("{overdue}", Number.isFinite(overdueMs) ? humanizeDuration(now - overdueMs) : "—")
}

/**
 * 催办的「不打扰」判定：默认按 policy.nonIntrusive，参数显式指定则覆盖。
 * @returns "dry-run" | "inject"（inject = conversation-link 的静默送达，不唤醒会话）。
 */
export function resolveRemindMode(nonIntrusive, explicitDryRun) {
  if (explicitDryRun === true) return "dry-run"
  if (explicitDryRun === false) return "inject"
  return nonIntrusive === false ? "inject" : "dry-run"
}

