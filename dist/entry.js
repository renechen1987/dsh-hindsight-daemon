// dsh-hindsight-daemon — GUI 入口:悬浮"记忆管理"按钮(由 webserver index-inject 注入)
(function () {
  "use strict";
  if (window.__dshHindsightEntry) return;
  window.__dshHindsightEntry = true;
  var btn = document.createElement("a");
  btn.href = "/hindsight-manager";
  btn.target = "_blank";
  btn.rel = "noopener";
  btn.textContent = "🧠 记忆";
  btn.title = "打开 Hindsight 本地记忆管理页";
  btn.style.cssText =
    "position:fixed;right:18px;bottom:18px;z-index:2147483000;" +
    "background:#1d2638;color:#dbe4f5;border:1px solid #4f8cff;border-radius:99px;" +
    "padding:8px 16px;font:13px/1.4 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;" +
    "text-decoration:none;box-shadow:0 4px 16px rgba(0,0,0,.35);user-select:none;" +
    "transition:transform .15s ease,background .15s ease;";
  btn.onmouseenter = function () { btn.style.background = "#2a3650"; btn.style.transform = "scale(1.05)"; };
  btn.onmouseleave = function () { btn.style.background = "#1d2638"; btn.style.transform = "scale(1)"; };
  var mount = function () {
    if (!document.body) { setTimeout(mount, 300); return; }
    document.body.appendChild(btn);
  };
  mount();
})();
