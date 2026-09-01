// dsh-hindsight-daemon — 浏览器端(client)插件
// 在 DSH「设置 → 插件配置」页注册一张卡片,提供记忆管理页入口。
// 结构完全对齐 dsh-univer-office 的做法:
//   package.json dsh.client 声明 + exports "./client" + 补丁行包名挂载
//   ctx.inject(["settingsScope"]) → slots.inject("settings.plugin.item", register({key}))
window.__ModuleLoader__.load({
  id: "dsh-hindsight-daemon",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var jsxRuntime = require("react/jsx-runtime");
    var NS = "dsh-hindsight-daemon";
    var CARD_STYLE = {
      display: "flex",
      flexDirection: "column",
      gap: "8px",
      padding: "14px 16px",
      background: "#171e2e",
      border: "1px solid #2a3650",
      borderRadius: "10px",
      font: "13px/1.5 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif",
      color: "#dbe4f5",
    };
    var LINK_STYLE = {
      display: "inline-flex",
      alignItems: "center",
      gap: "6px",
      padding: "6px 14px",
      borderRadius: "8px",
      background: "#1d2638",
      color: "#dbe4f5",
      border: "1px solid #4f8cff",
      textDecoration: "none",
      cursor: "pointer",
      fontSize: "13px",
      width: "fit-content",
    };
    function HindsightManagerCard() {
      return jsxRuntime.jsx("div", {
        style: CARD_STYLE,
        children: [
          jsxRuntime.jsx("div", { style: { fontWeight: 600, fontSize: 14 }, children: "🧠 Hindsight 记忆管理" }),
          jsxRuntime.jsx("div", {
            style: { color: "#8b98b5", fontSize: 12 },
            children: "本地记忆库:浏览 / 搜索 / 删除记忆、文档、知识页、审计日志、深度查询。",
          }),
          jsxRuntime.jsx("a", {
            href: "http://127.0.0.1:43121",
            target: "_blank",
            rel: "noopener",
            style: LINK_STYLE,
            children: "打开管理页 ↗",
          }),
        ],
      });
    }
    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.locale.register(NS, {
            zh: { title: "Hindsight 记忆管理" },
            en: { title: "Hindsight Memory Manager" },
          }),
        "hindsight: dictionaries"
      );
      ctx.inject(["settingsScope"], (settingsCtx) => {
        settingsCtx.effect(
          () =>
            settingsCtx.slots.inject(
              "settings.plugin.item",
              () =>
                settingsCtx.slots.register(
                  {
                    name: "settings.plugin.item",
                    key: NS,
                    locale: NS,
                    inject: () => ({}),
                  },
                  HindsightManagerCard
                ),
              "hindsight: manager card"
            ),
          "hindsight: settings card mount"
        );
      });
    }
    exports.apply = apply;
    exports.inject = ["slots", "locale"];
    return module.exports;
  },
});
