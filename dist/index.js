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
import { readFileSync, existsSync, readdirSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { HindsightServer, consoleLogger } from "@vectorize-io/hindsight-all";

const CONFIG_PATH = process.env.HINDSIGHT_CONFIG || join(homedir(), ".hindsight", "coding-agent.json");
const CREDENTIALS_PATH = join(homedir(), ".dsh", ".credentials.yaml");
const DAEMON_PORT = 9077;
const DAEMON_PROFILE = "coding-agent";
const READY_RETRY_MS = 15_000;
const READY_RETRY_MAX = 60; // ~15 分钟,覆盖冷启动(下载 embed + 模型 + 编译 litellm)

const name = "dsh-hindsight-daemon";

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
function readDeepSeekKey() {
  if (process.env.HINDSIGHT_API_LLM_API_KEY) return process.env.HINDSIGHT_API_LLM_API_KEY;
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const m = readFileSync(CREDENTIALS_PATH, "utf8").match(/^ {2}DEEPSEEK_API_KEY:\s*(\S+)/m);
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

/** daemon 进程需要的完整环境:LLM 配置 + uv/cargo 的 PATH。 */
function buildUserEnv() {
  const home = homedir();
  const env = {
    HINDSIGHT_API_LLM_PROVIDER: process.env.HINDSIGHT_API_LLM_PROVIDER || "deepseek",
    HINDSIGHT_API_LLM_MODEL: process.env.HINDSIGHT_API_LLM_MODEL || "deepseek-v4-flash",
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

function changeOpenSslPath(file, newLibDir) {
  try {
    const oldDir = "/opt/homebrew/opt/openssl@3/lib";
    const data = readFileSync(file, "utf8");
    if (!data.includes(oldDir)) return false;
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

let server = null;

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
  if (cfg.serverMode && cfg.serverMode !== "daemon") {
    log(`serverMode=${cfg.serverMode},本地 daemon 由官方 hindsight 插件/云端处理,本插件跳过`);
    return;
  }
  const env = buildUserEnv();
  const missing = preflight(env);
  if (missing) {
    logErr(`环境自检未通过:${missing}`);
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
    log(`daemon 已在 ${server.getBaseUrl()} 运行,直接复用`);
    return;
  }
  log("启动本地 daemon(冷启动可能需要数分钟:下载 embed + 模型,编译 litellm)…");
  try {
    await server.start();
    log(`daemon 就绪:${server.getBaseUrl()}`);
  } catch (err) {
    // 冷启动超时(默认 30s)不算失败:embed 仍在后台编译,轮询等待就绪
    logErr(`start 返回:${err?.message ?? err};继续在后台等待就绪…`);
    for (let i = 0; i < READY_RETRY_MAX; i++) {
      await new Promise((r) => setTimeout(r, READY_RETRY_MS));
      if (await server.checkHealth()) {
        log(`daemon 就绪:${server.getBaseUrl()}(后台完成)`);
        return;
      }
    }
    logErr("等待超时:daemon 未就绪,请查看 /tmp/hindsight-plugin.log");
  }
}

function apply() {
  enrichProcessEnv();
  // host 就绪后 1s 开始后台拉起(不阻塞 DSH 启动)
  const timer = setTimeout(() => {
    ensureDaemon().catch((err) => logErr(`启动失败:${err?.message ?? err}`));
  }, 1000);
  // DSH Desktop 退出 → 自动优雅停止 daemon
  return () => {
    clearTimeout(timer);
    log("DSH 退出,停止本地 daemon…");
    if (server) {
      server.stop().catch(() => {});
    }
  };
}

const plugin = { name, apply };
export default plugin;
export { name, apply, ensureDaemon, buildUserEnv, preflight, patchPg0OpenSsl };
