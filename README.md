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

## 📦 安装

```bash
# 1. 补装前置依赖(uv + Rust,已装过会自动跳过)
zsh ~/.dsh/plugins/dsh-hindsight-daemon/scripts/install-prereqs.sh

# 2. 复制插件到 DSH 插件目录
mkdir -p ~/.dsh/plugins
cp -R dsh-hindsight-daemon ~/.dsh/plugins/

# 3. 创建依赖链接(指向 DSH 已装的 hindsight-all)
mkdir -p ~/.dsh/plugins/dsh-hindsight-daemon/node_modules/@vectorize-io
ln -sfn ~/.dsh/profiles/desktop/node_modules/@vectorize-io/hindsight-all \
  ~/.dsh/plugins/dsh-hindsight-daemon/node_modules/@vectorize-io/hindsight-all

# 4. 挂载到 desktop profile 的补丁层
#    在 ~/.dsh/profiles/desktop/cordis.patch.yml 追加:
#    - insert:
#        - id: dsh-hindsight-daemon
#          name: /Users/<你>/.dsh/plugins/dsh-hindsight-daemon/dist/index.js
```

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

## 🧠 记忆管理页

插件会在 DSH 的 web 服务器上挂一个**本地记忆管理页**(v1.2.0+):

- **入口**:DSH 界面右下角的悬浮按钮「🧠 记忆」,或直接访问 `http://127.0.0.1:43120/hindsight-manager`
- **功能**:概览统计(记忆数/文档数/文本量)、记忆浏览/搜索/详情/删除、文档列表/重处理/删除、知识页搜索与树、审计日志、一键触发整合、LLM 连通测试、深度记忆查询(reflect)
- **原理**:页面与 API 代理都由插件挂在 DSH 自身的 webServer 上(同源,无 CORS 问题),不启动任何额外服务

## 📄 许可

MIT
