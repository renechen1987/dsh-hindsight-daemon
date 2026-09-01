# dsh-hindsight-daemon

> DeepSeek Harness Desktop 原生插件:DSH 启动时自动拉起本地 Hindsight daemon,退出时自动停止。

把 [Hindsight](https://hindsight.vectorize.io) 的**本地免费记忆**(daemon 模式)接入 DSH Desktop 的生命周期,全程无需手动操作、无需注册云端账号、不修改任何系统级配置。

## ✨ 特性

- **启动即拉起**:DSH Desktop 打开后,插件自动后台启动本地 daemon(`127.0.0.1:9077`)
- **退出即停止**:DSH 退出时自动调用 `daemon stop` 优雅关闭
- **环境自检**:自动检查 `uvx` / Rust 工具链 / DeepSeek API key,缺什么给出明确提示
- **一键补装**:`scripts/install-prereqs.sh` 自动安装 uv + Rust
- **自愈修复**:macOS 上自动修复 daemon 内嵌 PostgreSQL(pg0)的 OpenSSL 链接问题(标准 brew 缺失时)
- **自动复用**:daemon 已在运行时直接复用,不重复启动
- **智能跳过**:`~/.hindsight/coding-agent.json` 中 `serverMode` 非 `daemon` 时自动让位给官方插件/云端模式

## 📦 安装(任意机器,官方插件流程)

```bash
# 1. 克隆插件仓库
git clone https://github.com/renechen1987/dsh-hindsight-daemon.git ~/.dsh/plugins/dsh-hindsight-daemon

# 2. 补装前置依赖(uv;macOS 还需要 Rust,已装过会自动跳过)
zsh ~/.dsh/plugins/dsh-hindsight-daemon/scripts/install-prereqs.sh

# 3. 用 DSH 官方插件命令安装(会正确写入 package.json、lockfile 并挂载 bundle)
dsh plugin --profile desktop add link:~/.dsh/plugins/dsh-hindsight-daemon

# 4. 写配置(daemon 模式)
echo '{"serverMode":"daemon"}' > ~/.hindsight/coding-agent.json

# 5. 重启 DSH Desktop
```

**LLM key(二选一,不需要手动输入)**:
- 插件自动读取 `~/.dsh/.credentials.yaml` 中的 `DEEPSEEK_API_KEY`(DSH 凭据文件,与 DSH 主模型同源)
- 或设置环境变量 `HINDSIGHT_API_LLM_API_KEY` / `DEEPSEEK_API_KEY`(默认 provider=deepseek, model=deepseek-v4-flash)

**平台差异**:
- **macOS**:需要 Rust 工具链(litellm 无 macOS 预编译包);若本机没有标准 brew(`/opt/homebrew`),插件会自动修复 pg0 内嵌 PostgreSQL 的 OpenSSL 链接
- **Linux / Windows**:无需 Rust(pip 轮子直装),`scripts/install-prereqs.sh` 只装 uv

**验证**:重启后访问 `http://127.0.0.1:43121`(管理页)或 `curl http://127.0.0.1:9077/health`

**卸载**:`zsh ~/.dsh/plugins/dsh-hindsight-daemon/scripts/uninstall.sh`(或 `dsh plugin --profile desktop remove dsh-hindsight-daemon`)

> 📌 **注意**:本地 daemon 模式记忆存储在**本机**(每台机器独立 bank),不会跨机器同步。如需多机共享记忆,把 `serverMode` 改为 `cloud` 并配置 token。

## ⚙️ 配置

插件读取 `~/.hindsight/coding-agent.json`(Hindsight 官方配置文件的同一位置):

```json
{ "serverMode": "daemon" }
```

DeepSeek API key 自动从以下位置读取(优先级从高到低):

1. 环境变量 `HINDSIGHT_API_LLM_API_KEY` / `DEEPSEEK_API_KEY`
2. DSH 凭据文件 `~/.dsh/.credentials.yaml` 中的 `DEEPSEEK_API_KEY`

LLM 默认使用 `deepseek` / `deepseek-v4-flash`,可用环境变量 `HINDSIGHT_API_LLM_MODEL` 覆盖。

## 🗂 目录结构

```
dsh-hindsight-daemon/
├── dist/index.js              # 插件本体(Cordis host 平面插件)
├── scripts/install-prereqs.sh # uv + Rust 一键补装
└── package.json
```

## 🧠 工作原理

| 时机 | 动作 |
|---|---|
| DSH 启动 | 插件 `apply()` → 合并 daemon 所需环境(uv/cargo PATH + LLM key)→ 1 秒后后台 `ensureDaemon()` |
| daemon 未运行 | `HindsightServer.start()`:创建 profile(`coding-agent` @ 9077)→ `uvx hindsight-embed daemon start` → 等待健康 |
| daemon 已运行 | `/health` 探测通过 → 直接复用(官方插件也会复用同一个 daemon) |
| macOS 无标准 brew | 自动 `install_name_tool -change` 修复 pg0 内嵌 PostgreSQL 的 OpenSSL 链接 |
| DSH 退出 | 插件 teardown → `HindsightServer.stop()`(`daemon stop --profile coding-agent`) |

## 🩺 验证

```bash
curl http://127.0.0.1:9077/health
# {"status":"healthy","database":"connected",...}
```

DSH 会话内可用 `hindsight_diagnose` / `hindsight_sync_status` 查看记忆状态。

## 🗑 卸载

```bash
zsh ~/.dsh/plugins/dsh-hindsight-daemon/scripts/uninstall.sh
```

脚本会:① 把 `cordis.patch.yml` 恢复为默认空列表(移除挂载)② 停止本地 daemon。重启 DSH 后插件即不再加载。

> 若 DSH 启动失败(如渲染器 30s 超时),DSH 自带恢复机制:启动界面会提示回滚,回滚即还原 profile 与 patch,等效卸载。

## 🧠 记忆管理页

插件会启动一个独立的本地服务(127.0.0.1:43121,仅回环)**本地记忆管理页**(v1.2.0+):

- **入口**:DSH 界面右下角的悬浮按钮「🧠 记忆」,或直接访问 `http://127.0.0.1:43121`
- **功能**:概览统计(记忆数/文档数/文本量)、记忆浏览/搜索/详情/删除、文档列表/重处理/删除、知识页搜索与树、审计日志、一键触发整合、LLM 连通测试、深度记忆查询(reflect)
- **原理**:独立本地 HTTP 服务(仅绑定 127.0.0.1),页面与 API 代理同源,不依赖 DSH 的浏览器访问控制(Safari 等外部浏览器可直接打开)

## 📄 许可

MIT
