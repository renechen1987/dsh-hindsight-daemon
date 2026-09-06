/**
 * dsh-hindsight-daemon — DeepSeek Harness Desktop 原生插件
 *
 * DSH Desktop 启动时:自动拉起 Hindsight 本地 daemon(127.0.0.1:9077),
 * 自动带上 daemon 所需的环境(uv/cargo 的 PATH + DeepSeek LLM key)。
 * DSH Desktop 退出时:自动优雅停止 daemon。
 *
 * 依赖:
 *   - uv(uvx)   : https://astral.sh/uv  — daemon 运行器
 *   - Rust 工具链: https://rustup.rs     — macOS 上编译 litellm 需要
 *   - DeepSeek API key(自动从 ~/.dsh/.credentials.yaml 读取,或环境变量)
 *
 * 缺依赖时插件会记录明确诊断日志(见 /tmp/hindsight-plugin.log),
 * 可运行 scripts/install-prereqs.sh 一键补装。
 */
import {
  readFileSync,
  existsSync,
  readdirSync,
  openSync,
  readSync,
  closeSync,
  appendFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname as pathDirname } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { HindsightServer, consoleLogger } from "@vectorize-io/hindsight-all";
import z from "@deepseek-ai/schemastery";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";

const CONFIG_PATH = process.env.HINDSIGHT_CONFIG || join(homedir(), ".hindsight", "coding-agent.json");
const CREDENTIALS_PATH = join(homedir(), ".dsh", ".credentials.yaml");
const DAEMON_PORT = 9077;
const DAEMON_PROFILE = "coding-agent";
const READY_RETRY_MS = 15_000;
const READY_RETRY_MAX = 60; // ~15 分钟,覆盖冷启动(下载 embed + 模型 + 编译 litellm)
const DIAG_FILE = process.env.HINDSIGHT_DIAG_FILE || "/tmp/hindsight-plugin.log";
const HINDSIGHT_SETTINGS_NAMESPACE = "dsh-hindsight-daemon"; // 与 client 卡片 key 一致

const name = "dsh-hindsight-daemon";

/** 追加诊断日志到官方 hindsight 相同的 diag 文件,保证在 Electron 里可见。 */
function diag(event, extra = {}) {
  try {
    appendFileSync(
      DIAG_FILE,
      JSON.stringify({ ts: new Date().toISOString(), harness: "dsh", plugin: "dsh-hindsight-daemon", event, ...extra }) + "\n",
    );
  } catch {
    // 诊断失败不影响主流程
  }
}

function log(msg) {
  consoleLogger.info(`[dsh-hindsight-daemon] ${msg}`);
}
function logErr(msg) {
  consoleLogger.error(`[dsh-hindsight-daemon] ${msg}`);
}

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

/** 优先环境变量,其次 DSH 凭据文件(与用户授权一致,仅本机使用)。 */
/** 按优先级查找 DeepSeek key,返回 { key, source }:
 *  1) 环境变量(HINDSIGHT_API_LLM_API_KEY / DEEPSEEK_API_KEY / DEEPSEEK_KEY)
 *  2) 本机 DSH 凭据文件 ~/.dsh/.credentials.yaml(任意缩进,兼容 JSON/YAML 与多个字段名)
 *  3) 插件配置 ~/.hindsight/coding-agent.json 的 deepseekApiKey(UI「Settings」页保存)
 */
function readDeepSeekKeySource() {
  for (const k of ["HINDSIGHT_API_LLM_API_KEY", "DEEPSEEK_API_KEY", "DEEPSEEK_KEY"]) {
    const v = process.env[k];
    if (typeof v === "string" && v.trim() !== "") return { key: v.trim(), source: `env:${k}` };
  }
  try {
    const text = readFileSync(CREDENTIALS_PATH, "utf8");
    for (const name of ["DEEPSEEK_API_KEY", "DEEPSEEK_KEY", "deepseek_api_key", "deepseekApiKey"]) {
      const m = text.match(new RegExp(`^\\s*${name}\\s*:\\s*["']?([^"'\\s]+)["']?`, "m"));
      if (m && m[1]) return { key: m[1], source: `credentials-file:${name}` };
    }
  } catch {
    // 文件不可读则跳过
  }
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    const v = cfg && typeof cfg.deepseekApiKey === "string" && cfg.deepseekApiKey.trim() !== "" ? cfg.deepseekApiKey.trim() : undefined;
    if (v) return { key: v, source: "plugin-config" };
  } catch {
    // 无配置则跳过
  }
  return { key: undefined, source: undefined };
}

function readDeepSeekKey() {
  return readDeepSeekKeySource().key;
}

/** 读取 daemon profile 环境文件里实际用的 HINDSIGHT_API_LLM_API_KEY。 */
function readDaemonProfileKey(profile) {
  try {
    const text = readFileSync(join(homedir(), ".hindsight", "profiles", `${profile}.env`), "utf8");
    const m = text.match(/^HINDSIGHT_API_LLM_API_KEY\s*=\s*["']?([^"'\r\n]+)["']?/m);
    return m ? m[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

/** 掩码显示 key,避免明文进日志。 */
function maskKey(k) {
  if (!k) return "";
  return k.length > 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : "…";
}

/** daemon 进程需要的完整环境:LLM 配置 + uv/cargo 的 PATH。 */
function buildUserEnv() {
  const home = homedir();
  const env = {
    HINDSIGHT_API_LLM_PROVIDER: process.env.HINDSIGHT_API_LLM_PROVIDER || "deepseek",
    HINDSIGHT_API_LLM_MODEL: process.env.HINDSIGHT_API_LLM_MODEL || "deepseek-v4-flash",
    // 允许管理页的「测试 LLM 连通」按钮调用(daemon 默认禁用该端点)
    HINDSIGHT_API_ENABLE_BANK_LLM_HEALTH: process.env.HINDSIGHT_API_ENABLE_BANK_LLM_HEALTH || "true",
    PATH: [
      join(home, ".local", "bin"),
      join(home, ".cargo", "bin"),
      process.env.PATH || "",
    ].filter(Boolean).join(":"),
  };
  const key = readDeepSeekKey();
  if (key) env.HINDSIGHT_API_LLM_API_KEY = key;
  // macOS:daemon 的内嵌 PostgreSQL(pg0)写死找 /opt/homebrew/opt/openssl@3/lib。
  // 标准 brew 缺失时(如本机 brew 装在 ~/homebrew),用 DYLD_LIBRARY_PATH
  // 指向可用的 openssl@3 目录 —— 纯环境方案,不改系统。
  if (process.platform === "darwin" && !existsSync("/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib")) {
    const candidates = [
      join(home, "homebrew", "opt", "openssl@3", "lib"),
      "/Applications/ServBay/package/common/openssl/3.2/lib",
    ].filter((p) => existsSync(join(p, "libssl.3.dylib")));
    if (candidates.length > 0) {
      const extra = process.env.DYLD_LIBRARY_PATH || "";
      env.DYLD_LIBRARY_PATH = extra ? `${candidates[0]}:${extra}` : candidates[0];
      log(`本机无标准 brew openssl@3,注入 DYLD_LIBRARY_PATH=${candidates[0]}(pg0 内嵌 PostgreSQL 需要)`);
    } else {
      logErr("未找到可用的 openssl@3(libssl.3.dylib),daemon 内嵌 PostgreSQL 可能无法启动");
    }
  }
  return env;
}

function onPath(bin, envPath) {
  try {
    execFileSync("which", [bin], { env: { ...process.env, PATH: envPath }, stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** 环境自检:uv/Rust/LLM key,缺什么返回原因。 */
function preflight(env) {
  if (!onPath("uvx", env.PATH)) {
    return "缺少 uv(uvx 不在 PATH):请运行 ~/.dsh/plugins/dsh-hindsight-daemon/scripts/install-prereqs.sh,或按 https://astral.sh/uv 安装";
  }
  if (process.platform === "darwin" && !onPath("cargo", env.PATH)) {
    return "缺少 Rust 工具链(macOS 编译 litellm 需要):请运行 ~/.dsh/plugins/dsh-hindsight-daemon/scripts/install-prereqs.sh,或按 https://rustup.rs 安装";
  }
  if (!env.HINDSIGHT_API_LLM_API_KEY) {
    return "未找到 DeepSeek API key:设置环境变量 DEEPSEEK_API_KEY,或确认 ~/.dsh/.credentials.yaml 中存在 DEEPSEEK_API_KEY";
  }
  return null;
}

/**
 * macOS 自愈:daemon 内嵌 PostgreSQL(pg0,位于 ~/.pg0)硬链接了
 * /opt/homebrew/opt/openssl@3/lib 的 libssl/libcrypto。标准 brew 缺失时,
 * 把链接改指向可用的 openssl@3 并重新签名(仅用户目录,幂等)。
 * 返回 true 表示已处理(成功或无需处理)。
 */
function patchPg0OpenSsl() {
  if (process.platform !== "darwin") return true;
  if (existsSync("/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib")) return true; // 标准 brew 在,无事可做
  const candidates = [
    join(homedir(), "homebrew", "opt", "openssl@3", "lib"),
    "/Applications/ServBay/package/common/openssl/3.2/lib",
  ].filter((p) => existsSync(join(p, "libssl.3.dylib")));
  if (candidates.length === 0) {
    logErr("未找到可用的 openssl@3,无法修复 pg0 PostgreSQL 链接");
    return false;
  }
  const pg0Root = join(homedir(), ".pg0", "installation");
  if (!existsSync(pg0Root)) return true; // pg0 尚未下载,首次启动时由 daemon 自带
  let fixed = 0;
  try {
    const dirs = readdirSync(pg0Root).filter((d) => d.match(/^\d+\.\d+$/));
    for (const dir of dirs) {
      const walk = (d) => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, entry.name);
          if (entry.isDirectory()) walk(p);
          else if (entry.isFile() && isMachOBinary(p)) {
            const patched = changeOpenSslPath(p, candidates[0]);
            if (patched) fixed++;
          }
        }
      };
      walk(join(pg0Root, dir));
    }
  } catch (err) {
    logErr(`pg0 链接修复失败:${err?.message ?? err}`);
    return false;
  }
  if (fixed > 0) log(`已修复 ${fixed} 个 pg0 二进制文件的 OpenSSL 链接 → ${candidates[0]}`);
  return true;
}

/** 检查文件是否含旧路径引用;是则 install_name_tool 改链接并重新 ad-hoc 签名。 */
function isMachOBinary(p) {
  try {
    const fd = openSync(p, "r");
    const buf = Buffer.alloc(4);
    readSync(fd, buf, 0, 4, 0);
    closeSync(fd);
    return buf[0] === 0xcf && buf[1] === 0xfa && buf[2] === 0xed && buf[3] === 0xfe;
  } catch {
    return false;
  }
}

/**
 * 有界读取:只读文件头部(load commands 区域)检查是否含指定字节串。
 * 避免把 50-150MB 的二进制整读进内存(Mach-O 的 LC_LOAD_DYLIB 都在头部)。
 */
function fileContainsString(file, s, maxBytes = 2 * 1024 * 1024) {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const read = readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, read).toString("latin1").includes(s);
  } finally {
    closeSync(fd);
  }
}

function changeOpenSslPath(file, newLibDir) {
  try {
    const oldDir = "/opt/homebrew/opt/openssl@3/lib";
    if (!fileContainsString(file, oldDir)) return false;
    for (const lib of ["libssl.3.dylib", "libcrypto.3.dylib"]) {
      try {
        execFileSync("install_name_tool", ["-change", `${oldDir}/${lib}`, `${newLibDir}/${lib}`, file], {
          stdio: "pipe",
          timeout: 10000,
        });
      } catch {
        // 该文件未直接链接这个库,忽略
      }
    }
    try {
      execFileSync("codesign", ["-f", "-s", "-", file], { stdio: "pipe", timeout: 10000 });
    } catch {
      // 无签名或签名失败不影响动态加载(ad-hoc 重新签名后通常可恢复)
    }
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 记忆管理页:挂在 DSH 的 webServer 上(同源,无 CORS 问题),
// 并在 GUI 的 index.html 注入悬浮入口按钮(webserver/index-inject)。
// ---------------------------------------------------------------------------

let managerHtml = null;
let entryJs = null;

function loadStatic() {
  if (managerHtml === null) {
    const dir = pathDirname(fileURLToPath(import.meta.url));
    try {
      managerHtml = readFileSync(join(dir, "manager.html"), "utf8");
    } catch {
      managerHtml = "";
    }
    try {
      entryJs = readFileSync(join(dir, "entry.js"), "utf8");
    } catch {
      entryJs = "";
    }
  }
}

function daemonBase() {
  const cfg = loadConfig();
  if (cfg.apiUrl) return cfg.apiUrl.replace(/\/$/, "");
  return `http://127.0.0.1:${cfg.apiPort ?? DAEMON_PORT}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** 把 /hindsight-manager/api/* 代理到 daemon(同源,浏览器无需 CORS)。 */
async function proxyToDaemon(req, res, pathname) {
  try {
    // pathname 形如 /api/health 或 /api/v1/...;剥掉 /api 前缀后转发给 daemon
    const rest = pathname.startsWith("/api") ? pathname.slice(4) : pathname;
    const qIndex = req.url.indexOf("?");
    const target = daemonBase() + rest + (qIndex >= 0 ? req.url.slice(qIndex) : "");
    const headers = { ...req.headers };
    delete headers.host;
    delete headers["content-length"];
    const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await readBody(req) : undefined;
    const resp = await fetch(target, {
      method: req.method,
      headers,
      body,
      signal: AbortSignal.timeout(120000),
    });
    const buf = Buffer.from(await resp.arrayBuffer());
    res.writeHead(resp.status, {
      "content-type": resp.headers.get("content-type") || "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(buf);
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: String(err?.message ?? err) }));
  }
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

/** 读取插件配置文件(~/.hindsight/coding-agent.json)。 */
function readPluginConfigRaw() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

/** 原子写入插件配置文件。 */
function writePluginConfigRaw(next) {
  try {
    mkdirSync(pathDirname(CONFIG_PATH), { recursive: true });
  } catch {
    // 目录已存在则忽略
  }
  const tmp = `${CONFIG_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  renameSync(tmp, CONFIG_PATH);
}

/** 处理 /api/plugin/config:读取/更新 bank 路由等插件配置(UI「Banks & Routing」页使用)。 */
async function handlePluginConfig(req, res, pathname) {
  if (pathname !== "/api/plugin/config") return false;
  if (req.method === "GET") {
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify({ ok: true, config: readPluginConfigRaw() }));
    return true;
  }
  if (req.method === "PUT" || req.method === "POST") {
    try {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const cur = readPluginConfigRaw();
      const next = { ...cur };
      // serverMode 保持现状(默认 daemon),仅显式传入才允许修改
      if (typeof body.serverMode === "string") next.serverMode = body.serverMode;
      else if (!next.serverMode) next.serverMode = "daemon";
      // bankId:空字符串/null = 删除(恢复自动按项目)
      if ("bankId" in body) {
        if (typeof body.bankId === "string" && body.bankId.trim() !== "") next.bankId = body.bankId.trim();
        else delete next.bankId;
      }
      // mapPathToBank:对象,空值自动清理
      if ("mapPathToBank" in body) {
        const m = body.mapPathToBank;
        if (m && typeof m === "object") {
          const clean = {};
          for (const [k, v] of Object.entries(m)) {
            if (typeof k === "string" && k.trim() !== "" && typeof v === "string" && v.trim() !== "") {
              clean[k.trim()] = v.trim();
            }
          }
          if (Object.keys(clean).length > 0) next.mapPathToBank = clean;
          else delete next.mapPathToBank;
        } else {
          delete next.mapPathToBank;
        }
      }
      // 顶层布尔开关:总开关 disabled / 自动反射 autoReflect / 会话保留 retainSessions
      for (const key of ["disabled", "autoReflect", "retainSessions"]) {
        if (typeof body[key] === "boolean") next[key] = body[key];
      }
      // 按项目(记忆库)禁用:disabledBanks 数组 → banks.<id>.disabled
      if (Array.isArray(body.disabledBanks)) {
        next.banks = next.banks && typeof next.banks === "object" ? next.banks : {};
        for (const name of ["disabledBanks", "disabledBanksCleared"]) delete next[name];
        const disabledSet = new Set(body.disabledBanks.map((x) => String(x).trim()).filter(Boolean));
        // 先清空已有的 disabled 标记,再按本次列表重建
        for (const [id, section] of Object.entries(next.banks)) {
          if (section && typeof section === "object") delete section.disabled;
        }
        for (const id of disabledSet) {
          next.banks[id] = next.banks[id] && typeof next.banks[id] === "object" ? next.banks[id] : {};
          next.banks[id].disabled = true;
        }
        if (Object.keys(next.banks).length === 0) delete next.banks;
      }
      writePluginConfigRaw(next);
      log(`配置已更新:bankId=${next.bankId ?? "(auto)"}, 映射 ${Object.keys(next.mapPathToBank ?? {}).length} 条, disabled=${next.disabled ?? false}, autoReflect=${next.autoReflect ?? true}`);
      diag("config_updated", {
        bankId: next.bankId ?? null,
        mappings: Object.entries(next.mapPathToBank ?? {}).map(([p, b]) => `${p}→${b}`),
        disabled: next.disabled ?? false,
        autoReflect: next.autoReflect ?? true,
      });
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify({ ok: true, config: next }));
      return true;
    } catch (err) {
      res.writeHead(400, JSON_HEADERS);
      res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
      return true;
    }
  }
  res.writeHead(405, JSON_HEADERS);
  res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
  return true;
}

/** 处理 /api/plugin/key:读取/保存 DeepSeek key(UI「Settings」页使用)。 */
async function handlePluginKey(req, res, pathname) {
  if (pathname !== "/api/plugin/key") return false;
  if (req.method === "GET") {
    const { key, source } = readDeepSeekKeySource();
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify({ ok: true, configured: !!key, source: source ?? null, prefix: key ? key.slice(0, 7) : null }));
    return true;
  }
  if (req.method === "PUT" || req.method === "POST") {
    try {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const raw = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
      const cur = readPluginConfigRaw();
      const next = { ...cur };
      if (raw) next.deepseekApiKey = raw;
      else delete next.deepseekApiKey;
      writePluginConfigRaw(next);
      diag("key_updated", { configured: !!raw });
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify({ ok: true, configured: !!raw, config: next }));
      return true;
    } catch (err) {
      res.writeHead(400, JSON_HEADERS);
      res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
      return true;
    }
  }
  res.writeHead(405, JSON_HEADERS);
  res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
  return true;
}

async function managerHandler(req, res) {
  loadStatic();
  const pathname = new URL(req.url ?? "/", "http://x").pathname;
  if (pathname === "/" || pathname === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(managerHtml);
  } else if (pathname === "/entry.js") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    res.end(entryJs);
  } else if (pathname === "/api/plugin/key") {
    await handlePluginKey(req, res, pathname);
  } else if (pathname.startsWith("/api/plugin")) {
    await handlePluginConfig(req, res, pathname);
  } else if (pathname.startsWith("/api")) {
    await proxyToDaemon(req, res, pathname);
  } else {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
}

const MANAGER_PRIMARY_PORT = 43121; // 独立管理服务端口(DSH webServer 的 43120 之后)

/**
 * 启动独立管理服务(仅绑定 127.0.0.1):
 *  - 不依赖 DSH webServer/访问控制,Safari 等外部浏览器可直接打开
 *  - 端口被占用时顺延尝试 43122/43123/43124
 * 返回 http server 或 null。
 */
function startManagerServer() {
  loadStatic();
  const server = createServer((req, res) => {
    managerHandler(req, res).catch(() => {
      try {
        res.writeHead(500);
        res.end("internal error");
      } catch {
        // 响应已发送则忽略
      }
    });
  });
  const ports = [MANAGER_PRIMARY_PORT, 43122, 43123, 43124];
  return new Promise((resolve) => {
    let idx = 0;
    const attempt = () => {
      if (idx >= ports.length) {
        logErr("管理服务端口均被占用");
        resolve(null);
        return;
      }
      const port = ports[idx++];
      const onErr = (err) => {
        server.removeListener("error", onErr);
        if (err?.code === "EADDRINUSE") attempt();
        else {
          logErr(`管理服务启动失败:${err?.message ?? err}`);
          resolve(null);
        }
      };
      server.once("error", onErr);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", onErr);
        log(`记忆管理页已启动:http://127.0.0.1:${port}(Safari 可直接打开)`);
        diag("manager_started", { url: `http://127.0.0.1:${port}` });
        resolve(server);
      });
    };
    attempt();
  });
}

/** 启动独立管理服务 + GUI 悬浮入口注入;返回清理函数。 */
function setupManager(ctx) {
  const disposers = [];
  const offInject = ctx.on("webserver/index-inject", (table) => {
    // 关键:行字段是 kind(实测自 app.asar 运行版源码),不是 type ——
    // 字段名错误会让 renderRow 走 assertNever 抛异常 → 渲染器启动失败 → 30s 超时回滚。
    table.push({
      kind: "script-src",
      src: `http://127.0.0.1:${MANAGER_PRIMARY_PORT}/entry.js`,
      placement: "body",
    });
  });
  disposers.push(offInject);
  startManagerServer().then((srv) => {
    if (srv) disposers.push(() => srv.close());
  });
  return () => {
    for (const d of disposers) {
      try {
        d();
      } catch {
        // 忽略清理失败
      }
    }
  };
}

let server = null;
let stopped = false; // DSH 退出后不再继续等待/启动

/** 分离式停止:即使 DSH 进程立刻退出,stop 命令也能独立完成。 */
function stopDaemonDetached(profile, embedVersion) {
  const home = homedir();
  const env = {
    ...process.env,
    PATH: [join(home, ".local", "bin"), join(home, ".cargo", "bin"), process.env.PATH || ""]
      .filter(Boolean)
      .join(":"),
  };
  const version = embedVersion && embedVersion.length > 0 ? embedVersion : "latest";
  const child = spawn("uvx", [`hindsight-embed@${version}`, "daemon", "--profile", profile, "stop"], {
    detached: true,
    stdio: "ignore",
    env,
  });
  child.on("error", (err) => logErr(`停止命令失败:${err?.message ?? err}`));
  child.unref();
}

/**
 * 把 daemon 所需环境合入当前进程(仅补缺):
 *  - PATH 补上 ~/.local/bin 与 ~/.cargo/bin(DSH 从 Finder 启动时 PATH 很窄)
 *  - HINDSIGHT_API_LLM_* 未设置时才补(显式环境变量优先)
 * 这让官方 hindsight 插件的预检也能通过,并保证退出时 stop 命令能找到 uvx。
 */
function enrichProcessEnv() {
  const env = buildUserEnv();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    // DYLD_* 只进 daemon 进程,不污染 DSH 应用进程(避免影响 Electron/子进程)
    if (k.startsWith("DYLD_")) continue;
    if (k === "PATH") {
      if (!process.env.PATH || !process.env.PATH.includes(join(homedir(), ".local", "bin"))) {
        process.env.PATH = v;
      }
    } else if (process.env[k] === undefined) {
      process.env[k] = v;
    }
  }
}

async function ensureDaemon() {
  const cfg = loadConfig();
  // 与官方插件语义对齐:只有显式 serverMode=daemon 才由本插件接管;
  // 配置文件缺失/其他模式时让位给官方插件(官方缺省为 cloud)。
  if (cfg.serverMode !== "daemon") {
    log(`serverMode=${cfg.serverMode ?? "(未设置)"},本插件仅接管 daemon 模式,跳过`);
    return;
  }
  if (stopped) return;
  const env = buildUserEnv();
  const missing = preflight(env);
  if (missing) {
    logErr(`环境自检未通过:${missing}`);
    diag("preflight_failed", { reason: missing });
    return;
  }
  patchPg0OpenSsl(); // 自愈 pg0 PostgreSQL 的 OpenSSL 链接(幂等)
  server = new HindsightServer({
    port: cfg.apiPort ?? DAEMON_PORT,
    profile: cfg.daemonProfile ?? DAEMON_PROFILE,
    embedVersion: cfg.embedVersion,
    env,
    logger: consoleLogger,
  });
  if (await server.checkHealth()) {
    // daemon 在跑,但校验它用的 key 是否与当前有效 key 一致:
    // 若不一致(用户改了 key、或旧 daemon 烙着失效 key),必须重启以应用新 key,
    // 否则会一直沿用旧 key → 记忆抽取 401。
    const expectKey = env.HINDSIGHT_API_LLM_API_KEY;
    const daemonKey = readDaemonProfileKey(cfg.daemonProfile ?? DAEMON_PROFILE);
    if (expectKey && daemonKey && expectKey !== daemonKey) {
      log(`daemon 正在用旧 key(${maskKey(daemonKey)}),与当前(${maskKey(expectKey)})不一致,重启 daemon 以应用新 key…`);
      diag("key_mismatch_restart", { daemon: maskKey(daemonKey), expected: maskKey(expectKey) });
      try {
        await server.stop();
      } catch {
        // 停止失败也继续尝试启动
      }
      await new Promise((r) => setTimeout(r, 3000)); // 等端口释放
      try {
        await server.start();
        log(`daemon 已用新 key 重启:${server.getBaseUrl()}`);
        diag("ready", { apiUrl: server.getBaseUrl(), via: "key-mismatch-restart" });
        return;
      } catch (err) {
        logErr(`重启 daemon 失败:${err?.message ?? err}`);
      }
    }
    log(`daemon 已在 ${server.getBaseUrl()} 运行,直接复用`);
    diag("adopted", { apiUrl: server.getBaseUrl() });
    return;
  }
  log("启动本地 daemon(冷启动可能需要数分钟:下载 embed + 模型,编译 litellm)…");
  diag("starting", { apiUrl: server.getBaseUrl() });
  try {
    await server.start();
    log(`daemon 就绪:${server.getBaseUrl()}`);
    diag("ready", { apiUrl: server.getBaseUrl() });
  } catch (err) {
    // 冷启动超时(默认 30s)不算失败:embed 仍在后台编译,轮询等待就绪
    logErr(`start 返回:${err?.message ?? err};继续在后台等待就绪…`);
    for (let i = 0; i < READY_RETRY_MAX; i++) {
      await new Promise((r) => setTimeout(r, READY_RETRY_MS));
      if (stopped) return; // DSH 已退出,放弃等待
      // 首次重试前重新自愈:pg0 可能是启动过程中才下载的(带坏链接)
      if (i === 0) patchPg0OpenSsl();
      if (await server.checkHealth()) {
        log(`daemon 就绪:${server.getBaseUrl()}(后台完成)`);
        diag("ready", { apiUrl: server.getBaseUrl(), via: "retry" });
        return;
      }
    }
    logErr("等待超时:daemon 未就绪,请查看 /tmp/hindsight-plugin.log");
    diag("start_timeout", { apiUrl: server.getBaseUrl() });
  }
}

/**
 * 注册 host 侧 settings schema(对齐 dsh-univer-office 的做法)。
 * 「插件配置」页的"可配置"标签只显示 served 集合里的 namespace ——
 * served 来自 settings.describe,即必须有 host 侧 schema 注册,client 卡片才会出现。
 */
function setupHostSettings(ctx) {
  try {
    ctx.inject(["settings"], (settingsCtx) => {
      settingsCtx.settings.register(
        settingsNamespace(HINDSIGHT_SETTINGS_NAMESPACE),
        z.object({}),
        { base: {}, applies: "live" }
      );
      log(`设置 schema 已注册:${HINDSIGHT_SETTINGS_NAMESPACE}(插件配置页卡片将显示)`);
      diag("settings_registered", { namespace: HINDSIGHT_SETTINGS_NAMESPACE });
    });
  } catch (err) {
    logErr(`设置 schema 注册失败:${err?.message ?? err}`);
  }
}

function apply(ctx) {
  enrichProcessEnv();
  setupHostSettings(ctx);
  diag("loaded");
  const disposeManager = setupManager(ctx);
  // host 就绪后 1s 开始后台拉起(不阻塞 DSH 启动)
  const timer = setTimeout(() => {
    ensureDaemon().catch((err) => {
      logErr(`启动失败:${err?.message ?? err}`);
      diag("start_failed", { error: String(err?.message ?? err) });
    });
  }, 1000);
  // DSH Desktop 退出 → 自动停止 daemon(分离进程,保证 stop 执行完)
  return () => {
    clearTimeout(timer);
    disposeManager();
    if (stopped) return;
    stopped = true;
    log("DSH 退出,停止本地 daemon…");
    diag("stopping");
    if (server) {
      try {
        stopDaemonDetached(server.profile, server.embedVersion);
      } catch (err) {
        logErr(`停止失败:${err?.message ?? err}`);
      }
    }
  };
}

const plugin = { name, apply };
export default plugin;
export { name, apply, ensureDaemon, buildUserEnv, preflight, patchPg0OpenSsl, setupManager, managerHandler, startManagerServer, readDeepSeekKeySource, readDaemonProfileKey, maskKey };
