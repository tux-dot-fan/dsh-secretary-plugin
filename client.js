/**
 * `dsh-secretary` browser half —— 设置页「秘书」信息面板。
 *
 * 零构建：手写 loader closure factory（与 dsh-conversation-link /
 * dsh-skill-evolution 的 client 同一约定），React 从 shell 的模块表解析，
 * 面板数据经 fetch 调用 host 注册的 /secretary RPC 端点（overview/bind/unbind），
 * 全部操作在 host 侧落审计。面板是只读摘要 + 显式绑定操作，不持有任何权限。
 *
 * 「进入秘书会话」：优先用注入的 sessions.open(target) 切换 UI 会话；
 * 同时把 target 复制到剪贴板作兜底（在侧栏粘贴即可跳转）。
 */

window.__ModuleLoader__.load({
  id: "dsh-secretary",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    /** 运行时注入的 sessions 服务（apply 时赋值），供面板跳转会话。 */
    let ctx_sessions = undefined;

    const CHANNEL = "/api/secretary";

    function rpcId() {
      try { return crypto.randomUUID(); } catch {
        return "rpc-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
      }
    }

    async function rpc(endpoint, args) {
      const response = await fetch(CHANNEL + "/" + endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "client-request", rpcId: rpcId(), method: endpoint, payload: { args: args || {} } }),
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const envelope = await response.json();
      const result = envelope && envelope.result;
      if (!result || result.ok !== true) {
        const error = result && result.error;
        throw new Error(error ? error.message : "request failed");
      }
      return result.value;
    }

    function fmtTime(iso) {
      if (typeof iso !== "string" || iso.length === 0) return "-";
      try {
        const d = new Date(iso);
        const pad = (n) => String(n).padStart(2, "0");
        return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
          + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
      } catch { return iso; }
    }

    const CSS = `
.dsc-section{width:100%;max-width:760px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:14px;display:flex}
.dsc-head{align-items:flex-start;gap:10px;justify-content:space-between;display:flex}
.dsc-headTexts{flex-direction:column;gap:2px;display:flex;min-width:0}
.dsc-head h3{margin:0;font-size:15px;font-weight:600;line-height:22px}
.dsc-sub{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:18px}
.dsc-actions{align-items:center;gap:8px;display:flex;flex:none}
.dsc-btn{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer;background:0 0;border-radius:6px;align-items:center;gap:5px;padding:4px 10px;display:inline-flex}
.dsc-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsc-btn[data-primary=true]{color:var(--dsw-alias-state-business-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent)}
.dsc-btn:disabled{opacity:.55;cursor:default}
.dsc-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:12px 14px;flex-direction:column;gap:8px;display:flex}
.dsc-chiprow{flex-wrap:wrap;gap:6px;display:flex}
.dsc-chip{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap;border-radius:5px;padding:1px 7px;font-size:11px;line-height:18px;display:inline-flex}
.dsc-chip[data-kind=overdue]{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);color:var(--dsw-alias-state-error-primary);border-color:transparent}
.dsc-chip[data-kind=ok]{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);color:var(--dsw-alias-state-success-primary);border-color:transparent}
.dsc-chip[data-kind=code]{font-family:var(--ds-font-family-code)}
.dsc-row{align-items:center;gap:8px;justify-content:space-between;display:flex}
.dsc-rowLabel{color:var(--dsw-alias-label-secondary);font-size:12.5px}
.dsc-list{flex-direction:column;gap:5px;display:flex}
.dsc-item{font-size:12px;color:var(--dsw-alias-label-secondary);flex-direction:row;gap:8px;display:flex;align-items:baseline}
.dsc-item b{color:var(--dsw-alias-label-primary);font-weight:600}
.dsc-empty{color:var(--dsw-alias-label-tertiary);font-size:12.5px}
.dsc-failure{color:var(--dsw-alias-state-error-primary);align-items:center;gap:10px;display:flex;font-size:12.5px}
.dsc-status{color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:20px}
.dsc-input{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 8px;font:inherit;font-size:12.5px;min-width:180px}
.dsc-hint{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:16px}
@media (width<=680px){.dsc-head{flex-direction:column}}
`;

    function BindingCard({ overview, sessions, onChanged, onMessage }) {
      const binding = overview.binding;
      const [target, setTarget] = useState("");
      const [busy, setBusy] = useState(false);
      const canOpen = typeof sessions?.open === "function";

      const doBind = useCallback(() => {
        const value = (target || "").trim();
        if (value === "") return;
        setBusy(true);
        rpc("bind", { target: value })
          .then(() => { onChanged(); setTarget(""); onMessage("已绑定：" + value); })
          .catch((e) => onMessage("绑定失败：" + (e.message || e)))
          .finally(() => setBusy(false));
      }, [target, onChanged, onMessage]);

      const doUnbind = useCallback(() => {
        setBusy(true);
        rpc("unbind")
          .then(() => { onChanged(); onMessage("已解绑"); })
          .catch((e) => onMessage("解绑失败：" + (e.message || e)))
          .finally(() => setBusy(false));
      }, [onChanged, onMessage]);

      const doOpen = useCallback(() => {
        if (!binding) return;
        const value = binding.target;
        if (canOpen) { try { sessions.open(value); return; } catch {} }
        try { navigator.clipboard?.writeText(value); } catch {}
        onMessage("已复制 " + value + "，请在侧栏搜索/粘贴跳转（当前环境无自动切换）");
      }, [binding, canOpen, sessions, onMessage]);

      return h("div", { className: "dsc-card" },
        h("div", { className: "dsc-row" },
          h("span", { className: "dsc-rowLabel" }, "秘书会话绑定"),
          binding
            ? h("div", { className: "dsc-actions" },
                h("button", { type: "button", className: "dsc-btn", "data-primary": true, onClick: doOpen }, "进入秘书会话 →"),
                h("button", { type: "button", className: "dsc-btn", disabled: busy, onClick: doUnbind }, "解绑"))
            : null),
        binding
          ? h("div", { className: "dsc-chiprow" },
              h("span", { className: "dsc-chip", "data-kind": "code" }, binding.target),
              binding.name ? h("span", { className: "dsc-chip" }, binding.name) : null,
              h("span", { className: "dsc-chip" }, "绑定于 " + fmtTime(binding.updatedAt)))
          : h("div", { className: "dsc-row" },
              h("input", { className: "dsc-input", placeholder: "handle 或 sessionId（如 amber-heron）", value: target,
                onChange: (e) => setTarget(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") doBind(); } }),
              h("button", { type: "button", className: "dsc-btn", "data-primary": true, disabled: busy || target.trim() === "", onClick: doBind }, "绑定")),
        h("p", { className: "dsc-hint" }, "把最常管理秘书事务的那个会话绑为「秘书会话」，面板里点一下就能跳过去。" +
          (canOpen ? "" : "（当前环境未提供自动切换，绑定后按钮会复制目标供侧栏跳转）")));
    }

    function Overview({ view, sessions, refresh, onMessage }) {
      if (view.status === "loading") return h("p", { className: "dsc-status" }, "加载中…");
      if (view.status === "error") return h("div", { className: "dsc-failure" },
        h("p", {}, "无法读取秘书状态：" + view.message),
        h("button", { type: "button", className: "dsc-btn", onClick: refresh }, "重试"));
      const o = view.data;
      const s = o.taskStats || {};
      return h(React.Fragment, null,
        h(BindingCard, { overview: o, sessions, onChanged: refresh, onMessage }),
        h("div", { className: "dsc-card" },
          h("div", { className: "dsc-chiprow" },
            h("span", { className: "dsc-chip" }, "台账 " + o.rosterCount + " 张名片"),
            h("span", { className: "dsc-chip" }, "任务 进行中 " + s.open),
            h("span", { className: "dsc-chip", "data-kind": s.overdue > 0 ? "overdue" : undefined }, "逾期 " + s.overdue),
            h("span", { className: "dsc-chip", "data-kind": "ok" }, "已完成 " + s.done),
            h("span", { className: "dsc-chip" }, "取消 " + s.cancelled),
            h("span", { className: "dsc-chip" }, "交接 " + s.handedOff),
            s.total > 0 ? h("span", { className: "dsc-chip" }, "累计 " + s.total) : null),
          h("div", { className: "dsc-row" },
            h("span", { className: "dsc-rowLabel" }, "状态文件"),
            h("span", { className: "dsc-chip", "data-kind": "code" }, o.stateFile || "-"))),
        h("div", { className: "dsc-card" },
          h("div", { className: "dsc-row" }, h("span", { className: "dsc-rowLabel" }, "逾期任务（最多 10 条）")),
          Array.isArray(o.overdueTop) && o.overdueTop.length > 0
            ? h("div", { className: "dsc-list" }, o.overdueTop.map((t) =>
                h("div", { key: t.id, className: "dsc-item" },
                  h("span", { className: "dsc-chip", "data-kind": "overdue" }, "逾期"),
                  h("b", {}, t.subject),
                  h("span", {}, "→ " + t.assignee),
                  h("span", { className: "dsc-chip", "data-kind": "code" }, t.deadline ? fmtTime(t.deadline) : "-"))))
            : h("p", { className: "dsc-empty" }, "没有逾期任务，一切正常 👍")),
        h("div", { className: "dsc-card" },
          h("div", { className: "dsc-row" }, h("span", { className: "dsc-rowLabel" }, "行为规则（生效值）")),
          h("div", { className: "dsc-chiprow" },
            h("span", { className: "dsc-chip", "data-kind": o.policies.nonIntrusive ? "ok" : "overdue" },
              "催办不打扰：" + (o.policies.nonIntrusive ? "开（dry-run）" : "关")),
            h("span", { className: "dsc-chip" }, "宽限 " + o.policies.remindGraceMinutes + " 分钟"),
            h("span", { className: "dsc-chip" }, "单任务催办上限 " + o.policies.remindMaxPerTask),
            o.policies.remindTemplate ? h("span", { className: "dsc-chip", "data-kind": "code" }, "模板 " + o.policies.remindTemplate.slice(0, 24) + (o.policies.remindTemplate.length > 24 ? "…" : "")) : null),
          h("p", { className: "dsc-hint" }, "规则可在会话里用 secretary_policy 修改，这里只读展示。")));
    }

    function SecretarySection() {
      const [view, setView] = useState({ status: "loading" });
      const [message, setMessage] = useState("");
      const messageTimer = React.useRef(undefined);

      const load = useCallback(() => {
        setView({ status: "loading" });
        rpc("overview")
          .then((data) => setView({ status: "ready", data }))
          .catch((error) => setView({ status: "error", message: String(error.message || error) }));
      }, []);

      useEffect(() => { load(); }, [load]);
      useEffect(() => () => clearTimeout(messageTimer.current), []);

      const onMessage = useCallback((msg) => {
        setMessage(msg);
        clearTimeout(messageTimer.current);
        messageTimer.current = setTimeout(() => setMessage(""), 4000);
      }, []);

      return h("div", { className: "dsc-section" },
        h("style", {}, CSS),
        h("div", { className: "dsc-head" },
          h("div", { className: "dsc-headTexts" },
            h("h3", {}, "秘书 · dsh-secretary"),
            h("p", { className: "dsc-sub" }, "调度状态机 + 信息面板：会话台账、任务委派跟踪、进度看板、催办与汇报。通信层复用 conversation-link。")),
          h("div", { className: "dsc-actions" },
            message ? h("span", { className: "dsc-status" }, message) : null,
            h("button", { type: "button", className: "dsc-btn", onClick: load, disabled: view.status === "loading" }, "刷新"))),
        h(Overview, { view, sessions: ctx_sessions, refresh: load, onMessage }));
    }

    const inject = ["slots", "sessions"];

    function apply(ctx) {
      ctx_sessions = ctx.sessions;
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "dsh-secretary",
        order: 310,
        label: () => "秘书",
      }, SecretarySection));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});