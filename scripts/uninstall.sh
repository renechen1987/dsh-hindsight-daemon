#!/bin/zsh
# dsh-hindsight-daemon 卸载脚本
# 作用:1) 从 desktop profile 的 cordis.patch.yml 移除插件挂载
#       2) 停止本地 daemon(若在运行)
# 用法: zsh ~/.dsh/plugins/dsh-hindsight-daemon/scripts/uninstall.sh
set -e
PATCH="$HOME/.dsh/profiles/desktop/cordis.patch.yml"
PLUGIN_DIR="$HOME/.dsh/plugins/dsh-hindsight-daemon"

echo "==> 1/3 从 cordis.patch.yml 移除挂载…"
if [ -f "$PATCH" ]; then
  # 恢复为默认空补丁(该文件在安装插件前为空列表)
  cat > "$PATCH" <<'PATCH_EOF'
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).
[]
PATCH_EOF
  echo "    已移除(文件恢复为默认空列表)"
else
  echo "    未找到 patch 文件,跳过"
fi

echo "==> 2/3 停止本地 daemon(若在运行)…"
if [ -x "$HOME/.local/bin/uvx" ]; then
  "$HOME/.local/bin/uvx" hindsight-embed@latest daemon --profile coding-agent stop 2>/dev/null || true
  echo "    已发送停止命令"
else
  echo "    uvx 不存在,跳过"
fi

echo "==> 3/3 提示"
echo "    插件目录仍保留在: $PLUGIN_DIR"
echo "    如需彻底删除: rm -rf $PLUGIN_DIR"
echo
echo "✅ 卸载完成。重启 DSH Desktop 后插件即不再加载。"
