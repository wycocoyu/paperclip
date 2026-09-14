#!/usr/bin/env bash
# SessionStart 注入 v2（MUL-519 决策 12 / 21）。三段：
#
#   1. 身份行     ← Paperclip /api/agents/me
#   2. 常驻规则   ← OpenViking resources/team/rules/resident（全文，不走召回）
#   3. 资产地图   ← OpenViking memories/entities/资源文件（OV 自动维护的档案）
#
# 动作组规则（建卡/开分支/写卡/推状态/评审）不注入，用到时走 OpenViking 的 MCP 搜索召回。
# 常驻组不能走召回：用户提问里没有词能召回「不准直推 master」这类规则，
# 召回不到就是静默违规，没有报错（MUL-515）。
#
# v1 走 Paperclip 的 workspace/recall?mode=directory，那个端点随召回一起下架。
set -euo pipefail

# hook 的 PATH 由宿主决定，实测可能连 date / tr 都没有，自己补全系统路径。
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

# 工具用绝对路径。hook 的 PATH 由启动它的宿主决定，2026-09-02 有一次真实启动三段全空，
# 镜像被测试覆盖查不到原因，此后每步写状态到 last_inject.log 便于下次定位。
CURL=/usr/bin/curl
PY3=/usr/bin/python3
LOG="$HOME/.paperclip/last_inject.log"
mkdir -p "$HOME/.paperclip" 2>/dev/null || true
step() { printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$LOG" 2>/dev/null || true; }
step "start slug=${1:-} profile=${2:-} path=${PATH}"

API_BASE="${PAPERCLIP_API_BASE:-http://localhost:3100}"
OV_BASE="${OPENVIKING_URL:-http://127.0.0.1:1933}"
TERMINAL_SLUG="${1:-}"
PROFILE="${2:-}"

# 身份由注册方传 slug 决定，不做环境变量嗅探。v1 那次嗅探踩过两个坑：找 CODEX_SANDBOX
# 而非沙箱的 Codex 从不设它，以及继承变量让 ZCode shell 里起的 Codex 签成 zcode。
# 猜错比不猜更糟，认不出的调用方直接被告知，不借用别人的名字（MUL-113）。
#
# 但 slug 是注册时写死的常量，而一份 hook 配置可能被不止一个宿主执行：Cursor 会连
# Claude 的 SessionStart 一起跑，于是 Cursor 会话顶着 Claude 的 agent id 出现，正是
# MUL-113 要防的「借用别人的名字」。所以先让 CLI 按进程祖先认一次宿主。进程树不像
# 环境变量那样会被继承，CLI 也是先祖先后环境，探不出来才退回下面的 slug 分支。
PCLI=$(command -v paperclipai 2>/dev/null || command -v paperclip 2>/dev/null || true)
IDENTITY=""
if [ -n "$PCLI" ]; then
  IDENTITY=$("$PCLI" whoami --json 2>/dev/null | $PY3 -c '
import json,sys
try:
    d = json.load(sys.stdin)
    n, i = d.get("name"), d.get("id")
    print(f"你是 {n}（agent id {i}）" if d.get("kind") == "agent" and n and i else "", end="")
except Exception:
    pass
' 2>/dev/null) || IDENTITY=""
fi
step "detect=$([ -n "$IDENTITY" ] && echo ok || echo miss)"

case "$TERMINAL_SLUG" in
  claude-terminal|codex-terminal|zcode-terminal|cursor-terminal|qoder) KEY_FILE="$HOME/.paperclip/keys/$TERMINAL_SLUG" ;;
  *) KEY_FILE="" ;;
esac

if [ -z "$IDENTITY" ] && [ -n "$KEY_FILE" ] && [ -r "$KEY_FILE" ]; then
  KEY=$(tr -d '\r\n' < "$KEY_FILE")
  if [ -n "$KEY" ]; then
    IDENTITY=$($CURL -sf --max-time 3 -H "Authorization: Bearer ${KEY}" \
      "${API_BASE}/api/agents/me" 2>/dev/null | $PY3 -c '
import json,sys
try:
    d = json.load(sys.stdin)
    n, i = d.get("name"), d.get("id")
    print(f"你是 {n}（agent id {i}）" if n and i else "", end="")
except Exception:
    pass
' 2>/dev/null) || IDENTITY=""
  fi
fi
step "identity=$([ -n "$IDENTITY" ] && echo ok || echo EMPTY)"
[ -z "$IDENTITY" ] && IDENTITY="身份未取到：本次请求没有 agent 凭证，当前以 local-board 身份读取。终端会话应能自动发现自己的 key（~/.paperclip/keys/<终端>），先修凭证再干活。"

ov_get() {
  # GET 不是 POST，返回体的正文在 result 字段（2026-09-02 对着 /openapi.json 与实测核过）
  $CURL -sf --max-time 5 -G "${OV_BASE}$1" --data-urlencode "uri=$2" "${@:3}" 2>/dev/null | $PY3 -c '
import json,sys
try:
    d = json.load(sys.stdin)
    r = d.get("result")
    print(r if isinstance(r, str) else "", end="")
except Exception:
    pass
' 2>/dev/null || true
}

# Codex 只吃 hook 上下文的开头几行，长文会被截半。半部规则被当成整部读比没有更糟，
# 所以它拿身份行加一句自取指引，规则自己去 OpenViking 搜（MUL-117）。
if [ "$PROFILE" = "compact" ]; then
  TEXT="${IDENTITY}

本次未注入 Team Rules 全文（本终端只能接收开头少量内容，长文会被截断成半部规则）。做任何 Paperclip 相关动作之前，先跑一次 \`ov read viking://resources/team/rules/resident/resident.md\` 读常驻规则，会话内只需一次。"
else
  RULES=$(ov_get /api/v1/content/read "viking://resources/team/rules/resident/resident.md")
  # fs/tree 的 result 是数组不是字符串，所以不复用 ov_get（它只取 str）。
  # OV 会给每份资产自动维护一份带摘要的档案，读它比跑 tree 准（MUL-519 决策 21）。
  MAP=$($CURL -sf --max-time 5 -G "${OV_BASE}/api/v1/fs/tree" \
    --data-urlencode "uri=viking://user/default/memories/entities/资源文件" \
    --data-urlencode "level_limit=1" 2>/dev/null | $PY3 -c '
import json,sys
try:
    for r in json.load(sys.stdin).get("result") or []:
        if r.get("isDir"):
            continue
        name = (r.get("rel_path") or "").removesuffix(".md")
        note = (r.get("abstract") or "").strip().replace("\n", " ")
        print(f"  {name}" + (f" — {note[:70]}" if note else ""))
except Exception:
    pass
' 2>/dev/null) || MAP=""

  step "rules=$([ -n "$RULES" ] && echo ok || echo EMPTY) map=$([ -n "$MAP" ] && echo ok || echo EMPTY)"
  TEXT="${IDENTITY}"
  [ -n "$RULES" ] && TEXT="${TEXT}

=== Team Rules · 常驻组（每轮生效）===
${RULES}"
  # 地图取不到不是致命的，身份行仍要送达，所以这里不 early exit
  [ -n "$MAP" ] && TEXT="${TEXT}

=== 团队资产（OV 自动维护的档案，读它比跑 tree 准）===
${MAP}"
  TEXT="${TEXT}

动作组规则（建卡 / 开分支 / 写卡 / 推状态 / 评审）未注入，用到时召回：
  ~/开源工具/OpenViking/.venv/bin/ov find \"<一句自然语问法>\" --uri viking://resources/team
  （ov 不在 PATH 里，裸敲会 command not found，写全路径或用 openviking-memory 的 MCP 工具）"
fi

mkdir -p "$HOME/.paperclip" 2>/dev/null || true
[ -z "${PAPERCLIP_INJECT_DRYRUN:-}" ] && { printf '%s\n' "$TEXT" > "$HOME/.paperclip/last_inject.md" 2>/dev/null || true; }

# 正文走 stdin 而不是环境变量：规则全文几千字符带换行，env 传会被截断，
# 截出来的 JSON 带裸换行，Claude 解析失败后整段注入静默丢失。
printf '%s' "$TEXT" | $PY3 -c '
import json, sys
print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": sys.stdin.read()}}, ensure_ascii=False))
'
