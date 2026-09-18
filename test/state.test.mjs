/**
 * StateStore 冒烟测试：状态机合法迁移、原子落盘、逾期派生、审计环、交接。
 * 运行：npm test（node --test test/*.test.mjs）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore, isOverdue, POLICY_DEFAULTS, mintTaskId } from '../lib/state.js'

/** 建一个临时 store。 */
function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-secretary-test-"));
  const file = join(dir, "state.json");
  const store = new StateStore({ file, logger: undefined });
  return { dir, file, store };
}

/** 造一条任务，deadline 可选。 */
function makeTask(store, { subject = "样例任务", assignee = "alpha", deadline = "" } = {}) {
  return store.taskCreate({ subject, assignee, deadline }, { by: "owner" });
}

test("任务创建与读回（dispatched 默认 + 审计留痕）", () => {
  const { file, store } = makeStore();
  const task = makeTask(store, { deadline: "2030-01-01T00:00:00Z" });
  assert.equal(task.status, "dispatched");
  assert.equal(task.sent, false);
  assert.match(task.id, /^S-/);
  const read = store.taskGet(task.id);
  assert.equal(read.subject, "样例任务");
  assert.equal(read.assignee, "alpha");
  assert.ok(existsSync(file), "状态文件已落盘");
  assert.ok(!existsSync(file + ".tmp"), "无残留 tmp 文件");
  assert.equal(store.recentAudit(10)[0].event, "task.dispatched");
});

test("原子写入：无 .tmp 残留且 JSON 可解析", () => {
  const { file, store } = makeStore();
  for (let i = 0; i < 10; i += 1) makeTask(store, { subject: "任务" + i });
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(parsed.version, 1);
  assert.equal(Object.keys(parsed.tasks).length, 10);
  assert.ok(!existsSync(file + ".tmp"));
});

test("状态机：dispatched -> received -> pending_accept -> done，且终结后拒绝迁移", () => {
  const { store } = makeStore();
  let task = makeTask(store);
  task = store.taskTransition(task.id, "received", { by: "owner" });
  assert.equal(task.status, "received");
  assert.ok(task.receivedAt > 0);
  task = store.taskTransition(task.id, "pending_accept", { by: "owner" });
  assert.equal(task.status, "pending_accept");
  assert.ok(task.acceptedAt > 0);
  task = store.taskTransition(task.id, "done", { by: "owner" });
  assert.equal(task.status, "done");
  assert.ok(task.completedAt > 0);
  assert.throws(() => store.taskTransition(task.id, "received", { by: "owner" }), /终结态/);
});

test("逾期是派生状态：截止未到不算逾期，过了且未终结才算", () => {
  const { store } = makeStore();
  const soon = makeTask(store, { deadline: new Date(Date.now() - 60_000).toISOString() });
  const far = makeTask(store, { deadline: new Date(Date.now() + 86_400_000).toISOString() });
  assert.equal(isOverdue(soon), true, "过期 1 分钟应逾期");
  assert.equal(isOverdue(far), false, "明天截止不应逾期");
  const done = store.taskTransition(soon.id, "done", { by: "owner" });
  assert.equal(isOverdue(done), false, "已完结任务不算逾期");
});

test("审计环有界：超出 auditLimit 丢弃最旧", () => {
  const { store } = makeStore();
  store.policySet("auditLimit", 20, { by: "tester" });
  for (let i = 0; i < 30; i += 1) makeTask(store, { subject: "t" + i });
  assert.ok(store.recentAudit(100).length <= 20, "审计条数受 auditLimit 约束");
  assert.equal(store.policy("auditLimit"), 20);
});

test("交接：未完任务转给新接任者并留 handoffNote，已终结的不转", () => {
  const { store } = makeStore();
  const open = makeTask(store, { assignee: "alpha" });
  const done = makeTask(store, { assignee: "alpha" });
  store.taskTransition(done.id, "done", { by: "owner" });
  const moved = store.taskHandoff([open.id, done.id], "beta", { by: "owner", note: "临时接管" });
  assert.equal(moved.length, 1);
  assert.equal(moved[0].id, open.id);
  const after = store.taskGet(open.id);
  assert.equal(after.status, "handed_off");
  assert.equal(after.assignee, "beta");
  assert.equal(after.handoffNote, "临时接管");
  assert.equal(store.taskGet(done.id).status, "done", "已完结任务保持原状");
});

test("台账：upsert / bySession 反查 / remove", () => {
  const { store } = makeStore();
  store.rosterUpsert("amber-heron", { sessionId: "sess-1", role: "调研", status: "busy" });
  assert.equal(store.rosterBySession("sess-1").key, "amber-heron");
  store.rosterUpsert("amber-heron", { currentTask: "写报告" });
  assert.equal(store.rosterGet("amber-heron").currentTask, "写报告");
  assert.equal(store.rosterRemove("amber-heron").key, "amber-heron");
  assert.equal(store.rosterGet("amber-heron"), undefined);
});

test("损坏的状态文件被忽略，不炸挂载", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-secretary-bad-"));
  const file = join(dir, "state.json");
  writeFileSync(file, "{ 这不是 JSON", "utf8");
  const store = new StateStore({ file, logger: undefined });
  assert.equal(store.tasksAll().length, 0, "坏文件按空状态处理");
  store.rosterUpsert("x", { role: "r" });
  assert.equal(store.rosterGet("x").role, "r", "坏文件被修复后可继续写入");
});


test("秘书会话绑定：set/get/clear + 审计", () => {
  const { store } = makeStore();
  assert.equal(store.bindingGet(), undefined);
  const bound = store.bindingSet({ target: "amber-heron", name: "秘书会话" }, { by: "client" });
  assert.equal(bound.target, "amber-heron");
  assert.ok(bound.updatedAt > 0);
  assert.equal(store.bindingGet().name, "秘书会话");
  assert.equal(store.recentAudit(10)[0].event, "secretary.bound");
  store.bindingClear({ by: "client" });
  assert.equal(store.bindingGet(), undefined);
  // 非法绑定被拒
  assert.equal(store.bindingSet({ target: "" }, { by: "client" }), undefined);
});

test("mintTaskId 同毫秒不撞", () => {
  const a = mintTaskId(123);
  const b = mintTaskId(123);
  assert.notEqual(a, b);
});