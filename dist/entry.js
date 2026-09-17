// dsh-hindsight-daemon — GUI 入口:悬浮"Memory"按钮(由 webserver index-inject 注入)
// 按钮地址从自身 <script src> 推导管理服务端口(默认 127.0.0.1:43121)。
//
// 为什么是 <button> 而不是 <a href target="_blank">:
// dsh-better-sidebar 0.19 起注册了 document 级、捕获阶段的链接拦截,会吞掉 GUI 里所有
// http(s) 链接塞进它自己的侧边栏浏览器;而它的本地地址白名单(browserAllowedLoopback)
// 默认是空的,127.0.0.1 会被判为 blocked → 侧边栏空白、地址栏也不回填。
// button 不带 href,匹配不到它的 `a[href]` 选择器,点击会正常走 Electron 的
// setWindowOpenHandler → shell.openExternal,稳定地在系统浏览器里打开管理页。
(function () {
  "use strict";
  if (window.__dshHindsightEntry) return;
  window.__dshHindsightEntry = true;
  var base = "http://127.0.0.1:43121";
  try {
    if (document.currentScript && document.currentScript.src) {
      base = new URL(document.currentScript.src).origin;
    }
  } catch (e) { /* keep default */ }
  var url = base + "/";

  var btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Memory";
  btn.title = "Open the Hindsight memory manager — " + url;
  btn.setAttribute("aria-label", "Open the Hindsight memory manager");
  btn.style.cssText =
    "position:fixed;right:18px;bottom:18px;z-index:2147483000;" +
    "background:#1d2638;color:#dbe4f5;border:1px solid #4f8cff;border-radius:99px;" +
    "padding:8px 16px;font:13px/1.4 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;" +
    "cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.35);user-select:none;" +
    "transition:transform .15s ease,background .15s ease;";
  btn.onmouseenter = function () { btn.style.background = "#2a3650"; btn.style.transform = "scale(1.05)"; };
  btn.onmouseleave = function () { btn.style.background = "#1d2638"; btn.style.transform = "scale(1)"; };
  btn.addEventListener("click", function (event) {
    // 阻断冒泡:任何第三方 document 级点击拦截都不该再处理这一下
    event.preventDefault();
    event.stopPropagation();
    // 顺带把地址放进剪贴板,万一系统浏览器没弹出来也能直接 ⌘V
    try { navigator.clipboard.writeText(url); } catch (e) { /* 忽略 */ }
    try { window.open(url, "_blank", "noopener"); } catch (e) { /* 忽略 */ }
  });

  var mount = function () {
    if (!document.body) { setTimeout(mount, 300); return; }
    document.body.appendChild(btn);
  };
  mount();
})();
