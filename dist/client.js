// dsh-hindsight-daemon — 浏览器端(client)插件
// 在 DSH「设置 → 插件配置」页注册一张卡片,提供记忆管理页入口。
// 卡片结构与样式对齐 dsh-univer-office:li 卡片 + 可折叠 header + 展开 body,
// 全部使用 DSH 设计令牌(var(--dsw-alias-*))。
window.__ModuleLoader__.load({
  id: "dsh-hindsight-daemon",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var NS = "dsh-hindsight-daemon";
    var DICT = {
      "settings.title": "🧠 Hindsight 记忆管理",
      "settings.description": "本地记忆库:浏览 / 搜索 / 删除记忆、文档、知识页、审计日志、深度查询。",
      "settings.open": "打开管理页 ↗",
      "settings.collapse": "收起",
      "settings.expand": "展开",
    };
    /** 注入插件样式(同 univer 的 injectStyles 做法)。 */
    function injectStyles(id, css) {
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(id)}]`) !== null) return;
      var style = document.createElement("style");
      style.dataset.plugin = "dsh-hindsight-daemon";
      style.dataset.pluginCss = id;
      style.textContent = css;
      document.head.appendChild(style);
    }
    var CARD_STYLES = `
.dhh-settingsCard{list-style:none;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);transition:border-color .16s,background .16s}
.dhh-settingsCard:hover{border-color:var(--dsw-alias-label-dimmed)}
.dhh-settingsCard_open{border-color:var(--dsw-alias-label-dimmed);background:var(--dsw-alias-bg-layer-2)}
.dhh-settingsHeader{display:flex;width:100%;align-items:center;gap:12px;padding:14px 16px;appearance:none;border:0;border-radius:12px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dhh-settingsHeader:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dhh-settingsHeadText{display:flex;min-width:0;flex:1;flex-direction:column;gap:4px}
.dhh-settingsName{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}
.dhh-settingsDescription{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dhh-settingsChevron{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;transition:transform .16s}
.dhh-settingsChevron_open{transform:rotate(180deg)}
.dhh-settingsBody{margin:0 16px;padding:12px 0 14px;border-top:1px solid var(--dsw-alias-border-l2)}
.dhh-settingsOpenButton{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;text-decoration:none;cursor:pointer}
.dhh-settingsOpenButton:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dhh-settingsOpenButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
`;
    function HindsightManagerCard(props) {
      var useState = react.useState;
      var _open = useState(false);
      var open = _open[0];
      var setOpen = _open[1];
      var t = props.t;
      return react.createElement(
        "li",
        { className: "dhh-settingsCard" + (open ? " dhh-settingsCard_open" : "") },
        react.createElement(
          "button",
          {
            type: "button",
            className: "dhh-settingsHeader",
            "aria-expanded": open,
            "aria-label": t(open ? "settings.collapse" : "settings.expand") + ": " + t("settings.title"),
            onClick: function () { setOpen(function (v) { return !v; }); },
          },
          react.createElement(
            "span",
            { className: "dhh-settingsHeadText" },
            react.createElement("span", { className: "dhh-settingsName" }, t("settings.title")),
            react.createElement("span", { className: "dhh-settingsDescription" }, t("settings.description"))
          ),
          react.createElement(
            "span",
            { className: "dhh-settingsChevron" + (open ? " dhh-settingsChevron_open" : "") },
            "▾"
          )
        ),
        open
          ? react.createElement(
              "div",
              { className: "dhh-settingsBody" },
              react.createElement(
                "a",
                {
                  className: "dhh-settingsOpenButton",
                  href: "http://127.0.0.1:43121",
                  target: "_blank",
                  rel: "noopener",
                },
                t("settings.open")
              )
            )
          : null
      );
    }
    function apply(ctx) {
      injectStyles("dsh-hindsight-daemon/settings-styles", CARD_STYLES);
      ctx.effect(
        function () {
          return ctx.locale.register(NS, { zh: DICT, en: DICT });
        },
        "hindsight: dictionaries"
      );
      ctx.inject(["settingsScope"], function (settingsCtx) {
        settingsCtx.effect(
          function () {
            return settingsCtx.slots.inject(
              "settings.plugin.item",
              function () {
                return settingsCtx.slots.register(
                  {
                    name: "settings.plugin.item",
                    key: NS,
                    locale: NS,
                    inject: function () {
                      return {
                        t: function (key) { return DICT[key] || key; },
                      };
                    },
                  },
                  HindsightManagerCard
                );
              },
              "hindsight: manager card"
            );
          },
          "hindsight: settings card mount"
        );
      });
    }
    exports.apply = apply;
    exports.inject = ["slots", "locale"];
    return module.exports;
  },
});
