#!/bin/zsh
# dsh-hindsight-daemon 前置依赖一键安装:uv + Rust 工具链(macOS 必需)
# 用法: zsh ~/.dsh/plugins/dsh-hindsight-daemon/scripts/install-prereqs.sh
set -e
echo "==> 检查 uv …"
if command -v uvx >/dev/null 2>&1 || [ -x "$HOME/.local/bin/uvx" ]; then
  echo "    uv 已安装 ($("$HOME/.local/bin/uvx" --version 2>/dev/null || command -v uvx))"
else
  echo "==> 安装 uv(官方脚本,装入 ~/.local/bin)…"
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi

echo "==> 检查 Rust 工具链 …"
if command -v cargo >/dev/null 2>&1 || [ -x "$HOME/.cargo/bin/cargo" ]; then
  echo "    Rust 已安装 ($("$HOME/.cargo/bin/cargo" --version 2>/dev/null || command -v cargo))"
else
  echo "==> 安装 Rust(rustup minimal,装入 ~/.cargo、~/.rustup)…"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
fi

echo
echo "==> 完成。重启 DSH Desktop 后,插件会自动拉起本地 daemon。"
echo "    验证: curl http://127.0.0.1:9077/health"
