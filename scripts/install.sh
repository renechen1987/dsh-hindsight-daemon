#!/bin/zsh
# dsh-hindsight-daemon 一键安装(任意机器)
# 用法:解压后进入目录,运行 zsh install.sh
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$HOME/.dsh/plugins/dsh-hindsight-daemon"

echo "==> 1/4 复制插件到 ~/.dsh/plugins/dsh-hindsight-daemon"
mkdir -p "$HOME/.dsh/plugins"
if [ -e "$PLUGIN_DIR" ] && [ "$(cd "$PLUGIN_DIR" && pwd)" != "$SRC" ]; then
  echo "    目标目录已存在,跳过复制(使用现有目录)"
else
  cp -R "$SRC" "$PLUGIN_DIR"
fi

echo "==> 2/4 补装前置依赖(uv;macOS 另需 Rust)"
zsh "$PLUGIN_DIR/scripts/install-prereqs.sh"

echo "==> 3/4 写配置 ~/.hindsight/coding-agent.json(daemon 模式)"
mkdir -p "$HOME/.hindsight"
if [ -f "$HOME/.hindsight/coding-agent.json" ]; then
  echo "    配置文件已存在,保留:$(cat "$HOME/.hindsight/coding-agent.json")"
else
  echo '{"serverMode":"daemon"}' > "$HOME/.hindsight/coding-agent.json"
  echo "    已写入 {\"serverMode\":\"daemon\"}"
fi

echo "==> 4/4 用 DSH 官方命令挂载插件"
if command -v dsh >/dev/null 2>&1; then
  dsh plugin --profile desktop add "link:$PLUGIN_DIR" || true
else
  echo "    未找到 dsh CLI,请手动运行: dsh plugin --profile desktop add link:$PLUGIN_DIR"
fi

echo
echo "✅ 安装完成。请重启 DSH Desktop。"
echo "   管理页: http://127.0.0.1:43121   健康检查: curl http://127.0.0.1:9077/health"
echo "   DeepSeek key 会自动从 DSH 凭据(~/.dsh/.credentials.yaml)读取,无需手动输入。"
