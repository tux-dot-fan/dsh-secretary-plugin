/**
 * 最小宿主挂载冒烟：不需要真实 Harness，模拟 ctx(tools/on/logger) 调用 apply()，
 * 验证 8 个工具注册、状态操作快乐路径、以及 conversation-link 缺失时的降级路径。
 * 运行：node scripts/smoke.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, resolveStateFile } from '../index.js'

const dir = mkdtempSync(join(tmpdir(), "dsh-secretary-smoke-"));
const registered = new Map();
const tools = {
  register(def) { registered.set(def.name, def); },
  get(name, agent) { return registered.has(name) ? registered.get(name) : undefined; },
  async execute({ name, agent, arguments: args }) {
    const def = registered.get(name);
    if (!def) {
      return { name, isError: true, content: [{ type: "text", text: "UNKNOWN_TOOL: " + name + " not registered" }] };
    }
    return await def.execute(args, { agent });
  },
};
const logger = { info() {}, warn() {}, error() {} };
const rpcHandlers = new Map();
const connection = {
  rpc: {
    handle(channel, handler) { rpcHandlers.set(channel, handler); },
  },
};
const ctx = {
  get(name) {
    if (name === "tools") return tools;
    if (name === "logger") return logger;
    if (name === "connection") return connection;
    return undefined;
  },
  tools,
  on() {},
};

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : ""));
  if (!cond) failures += 1;
}

apply(ctx, { stateDir: dir });
check("8 个工具全部注册", registered.size === 8, [...registered.keys()]);

const agent = { id: "owner-session" };

const roster = await tools.execute({ name: "secretary_roster", agent, arguments: { action: "upsert", handle: "amber-heron", role: "调研", status: "busy" } });
check("台账 upsert", roster.entries.length === 1 && roster.entries[0].role === "调研");

const assigned = await tools.execute({ name: "secretary_assign", agent, arguments: { to: "amber-heron", subject: "调研 A 库", deadline: "2030-01-01", send: false } });
check("派单记录(不发送)", assigned.task.status === "dispatched" && assigned.delivery.delivered === "deferred", assigned.task.id);

const tasks = await tools.execute({ name: "secretary_tasks", agent, arguments: {} });
check("任务清单", tasks.count === 1 && tasks.tasks[0].displayStatus === "dispatched");

const remind = await tools.execute({ name: "secretary_remind", agent, arguments: {} });
check("催办 dry-run 不发送", remind.dryRun === true && remind.count === 0);

const overdueAssign = await tools.execute({ name: "secretary_assign", agent, arguments: { to: "amber-heron", subject: "过期任务", deadline: new Date(Date.now() - 3_600_000).toISOString(), send: false } });
const remindReal = await tools.execute({ name: "secretary_remind", agent, arguments: { dryRun: false, taskId: overdueAssign.task.id } });
check("催办真发→conversation-link 缺失时降级 deferred", remindReal.sent.length === 1 && remindReal.sent[0].delivered === "deferred", remindReal.mode);

const report = await tools.execute({ name: "secretary_report", agent, arguments: { scope: "all" } });
check("汇报生成", report.summary.total === 2 && report.markdown.includes("# 秘书汇报"));

const policy = await tools.execute({ name: "secretary_policy", agent, arguments: { action: "set", key: "remindGraceMinutes", value: "30" } });
check("策略设置+类型转换", policy.result.value === 30);
const policyList = await tools.execute({ name: "secretary_policy", agent, arguments: { action: "list" } });
check("策略查看(默认+覆盖)", policyList.policies.remindGraceMinutes === 30 && policyList.policies.nonIntrusive === true);

const handoff = await tools.execute({ name: "secretary_handoff", agent, arguments: { to: "beta", send: false } });
check("交接(未完结任务)", handoff.moved.length === 2 && handoff.package.items[0].to === "beta");

const board = await tools.execute({ name: "secretary_board", agent, arguments: {} });
check("看板 fail-open(无 conversation-link)", board.entries.length === 0 && board.summary.sessions === 0, board.unreachable.length + " unreachable");

// ---- /secretary RPC（client 面板端点） ----
check("RPC channel 注册", rpcHandlers.has("/secretary"));
const rpc = (endpoint, args) => rpcHandlers.get("/secretary")(endpoint, { args: args || {} }, undefined);
const overview1 = rpc("overview", {});
check("RPC overview：任务统计", overview1.ok === true && overview1.value.taskStats.total === 2, overview1.value && overview1.value.taskStats);
check("RPC overview：绑定为空", overview1.ok === true && overview1.value.binding === null);
const bound = rpc("bind", { target: "amber-heron", name: "秘书会话" });
check("RPC bind：绑定", bound.ok === true && bound.value.target === "amber-heron");
const overview2 = rpc("overview", {});
check("RPC overview：绑定已生效", overview2.value.binding.target === "amber-heron" && overview2.value.binding.name === "秘书会话");
check("RPC 未知端点拒绝", rpc("nope", {}).ok === false);
const unbound = rpc("unbind", {});
check("RPC unbind：解绑", unbound.ok === true);
console.log("");
console.log(failures === 0 ? "SMOKE ALL PASS ✅" : "SMOKE FAILURES: " + failures + " ❌");
console.log("state file:", resolveStateFile({ stateDir: dir }));
process.exit(failures === 0 ? 0 : 1);
