#!/usr/bin/env bash
# claude-code-manager: 新しいクライアント端末の初期設定 (冪等)。
#
# やること:
#   1. python3 の存在確認 + 絶対パス解決 (Homebrew のみの Mac でも PATH に依存しないように)
#   2. hook (ai-monitor/hooks/ccm-awaiting-marker.py) を ~/.claude/hooks/ へ配置 (+x・差分時のみ上書き)
#   3. ~/.claude/settings.json の PermissionRequest / PostToolUse / Stop に hook を冪等マージ
#      (既存 notify-*.py 等を壊さない・二重登録しない・バックアップを残す)
#   4. .env が無ければ .env.example から雛形を作り、client モードに必要な値の記入を案内
#   5. 次の一歩 (./run-ai-monitor-client.sh) を表示
#
# 何度実行しても安全 (idempotent)。settings.json / hook は変更前に .bak を作る。
# 詳細・hook あり/なし比較は docs/plans/new-client-setup.md を参照。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK_SRC="$REPO_ROOT/ai-monitor/hooks/ccm-awaiting-marker.py"
CLAUDE_DIR="$HOME/.claude"
HOOK_DST="$CLAUDE_DIR/hooks/ccm-awaiting-marker.py"
SETTINGS="$CLAUDE_DIR/settings.json"
ENV_FILE="$REPO_ROOT/.env"
ENV_EXAMPLE="$REPO_ROOT/.env.example"
# 旧 hook が PermissionRequest の生ペイロード (tool_input 含む) を書いていたデバッグダンプ。
# 現行 hook は書かないが、旧版から上げる端末には残骸が残るのでアップグレード時に必ず掃除する。
LEGACY_DUMP="/tmp/claude-code-manager/last-permission-request.json"

info()  { printf '\033[36m[setup]\033[0m %s\n' "$*"; }
ok()    { printf '\033[32m[ ok ]\033[0m %s\n' "$*"; }
warn()  { printf '\033[33m[warn]\033[0m %s\n' "$*" >&2; }
die()   { printf '\033[31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

# ── 0. 前提ファイル ───────────────────────────────────────────────
[ -f "$HOOK_SRC" ] || die "hook 正本が見つからない: $HOOK_SRC (リポジトリ root から実行しているか確認)"

# ── 1. python3 の存在確認 + 絶対パス解決 ──────────────────────────
PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then
  case "$(uname -s)" in
    Darwin) die "python3 が見つからない。Xcode CLT (xcode-select --install) か Homebrew (brew install python) で導入してから再実行する。" ;;
    *)      die "python3 が見つからない。OS のパッケージマネージャで python3 を導入してから再実行する。" ;;
  esac
fi
# settings.json には絶対パスを書き込む。hook を起動するシェルの PATH に依存しないようにする。
HOOK_CMD="$PY \$HOME/.claude/hooks/ccm-awaiting-marker.py"
ok "python3: $PY"

# ── 2. hook を ~/.claude/hooks/ へ配置 ────────────────────────────
mkdir -p "$CLAUDE_DIR/hooks"
if [ -f "$HOOK_DST" ] && cmp -s "$HOOK_SRC" "$HOOK_DST"; then
  ok "hook は最新 (差分なし): $HOOK_DST"
else
  if [ -f "$HOOK_DST" ]; then
    cp -p "$HOOK_DST" "$HOOK_DST.bak"
    warn "既存 hook をバックアップ: $HOOK_DST.bak"
  fi
  cp "$HOOK_SRC" "$HOOK_DST"
  chmod +x "$HOOK_DST"
  ok "hook を配置: $HOOK_DST"
fi

# ── 2b. 旧 hook が残した raw permission dump を掃除 (privacy・冪等) ──
# 旧版からアップグレードする端末には tool_input を含む生ペイロードが /tmp に残っているため必ず削除。
if [ -f "$LEGACY_DUMP" ]; then
  rm -f "$LEGACY_DUMP"
  ok "旧 raw permission dump を削除: $LEGACY_DUMP"
fi

# ── 3. settings.json へ冪等マージ ─────────────────────────────────
# marker スクリプトを参照する hook を PermissionRequest / PostToolUse / Stop に保証する。
# 既に参照があればコマンドを正規形 (絶対 python3 パス) に更新し、無ければ追記する。
# JSON 不正時は書き込まず中断 (既存設定を壊さない)。
info "settings.json へ hook をマージ: $SETTINGS"
"$PY" - "$SETTINGS" "$HOOK_CMD" <<'PYEOF'
import json, os, shutil, sys, tempfile

settings_path, command = sys.argv[1], sys.argv[2]
MARKER = "ccm-awaiting-marker.py"
EVENTS = ["PermissionRequest", "PostToolUse", "Stop"]

# 読み込み: 無い/空 → {}、不正 JSON → 中断 (上書きしない)
if os.path.exists(settings_path):
    with open(settings_path) as f:
        raw = f.read()
    if raw.strip():
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as e:
            sys.stderr.write("settings.json が不正な JSON: %s\n" % e)
            sys.exit(2)
    else:
        data = {}
else:
    data = {}

if not isinstance(data, dict):
    sys.stderr.write("settings.json の最上位が object でない\n")
    sys.exit(2)

hooks = data.setdefault("hooks", {})
if not isinstance(hooks, dict):
    sys.stderr.write("settings.json の hooks が object でない\n")
    sys.exit(2)

changed = []
for ev in EVENTS:
    groups = hooks.setdefault(ev, [])
    if not isinstance(groups, list):
        sys.stderr.write("settings.json の hooks.%s が array でない\n" % ev)
        sys.exit(2)
    found = False
    for g in groups:
        if not isinstance(g, dict):
            continue
        for h in g.get("hooks", []) or []:
            if isinstance(h, dict) and MARKER in (h.get("command") or ""):
                found = True
                if h.get("command") != command:
                    h["command"] = command   # plain python3 → 絶対パス へ移行 / 重複防止
                    changed.append(ev + " (更新)")
    if not found:
        groups.append({"hooks": [{"type": "command", "command": command, "async": True}]})
        changed.append(ev + " (追加)")

if not changed:
    print("UNCHANGED")
    sys.exit(0)

# 書き込み: 変更前にバックアップ → temp へ書いて atomic に置換
if os.path.exists(settings_path):
    shutil.copy2(settings_path, settings_path + ".bak")
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(settings_path) or ".", prefix=".settings-")
with os.fdopen(fd, "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.replace(tmp, settings_path)
print("CHANGED: " + ", ".join(changed))
PYEOF
merge_rc=$?
case "$merge_rc" in
  0) : ;;
  2) die "settings.json のマージに失敗 (JSON 不正など)。$SETTINGS を確認して修正後に再実行する。" ;;
  *) die "settings.json のマージに失敗 (rc=$merge_rc)。" ;;
esac
ok "settings.json マージ完了 (変更時のみ $SETTINGS.bak を作成)"

# ── 4. .env 雛形 ──────────────────────────────────────────────────
if [ -f "$ENV_FILE" ]; then
  ok ".env は既に存在: $ENV_FILE (client 用の値は手動で確認)"
else
  if [ -f "$ENV_EXAMPLE" ]; then
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    ok ".env を雛形から作成: $ENV_FILE"
  else
    warn ".env.example が無いため .env を作れなかった: $ENV_EXAMPLE"
  fi
fi
# client モードで必須の値が未設定/プレースホルダのまま残っていないか確認
if [ -f "$ENV_FILE" ]; then
  for kv in "CCM_SERVER_URL" "CCM_CLIENT_TOKEN" "CCM_CLIENT_LABEL"; do
    line="$(grep -E "^$kv=" "$ENV_FILE" | tail -n1 || true)"
    val="${line#*=}"
    case "$val" in
      ""|CHANGE_ME*|*example.com*|*xxxxx*)
        warn ".env の $kv を実値に設定する (現在: ${val:-未設定})" ;;
    esac
  done
fi

# ── 5. 次の一歩 ───────────────────────────────────────────────────
echo
ok "セットアップ完了。"
cat <<EOF

次の一歩:
  1) $ENV_FILE を編集し、client モードの値を埋める:
       CCM_SERVER_URL   … 公開サーバの URL (https://...)
       CCM_CLIENT_TOKEN … この端末の Bearer (server 側 CCM_INGEST_TOKENS のいずれかと一致)
       CCM_CLIENT_LABEL … この端末の表示名 (未設定なら hostname)
  2) client モードで起動:
       ./run-ai-monitor-client.sh

hook (権限プロンプトの「入力待ち」検出) はこのスクリプトで配置済み。
hook あり/なしの挙動差は docs/plans/new-client-setup.md を参照。
EOF
