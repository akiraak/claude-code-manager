#!/usr/bin/env python3
"""claude-code-manager の入力待ち検知用 marker。

ai-monitor (https://github.com/akiraak/claude-code-manager) のダッシュボードが
権限プロンプト保留中の Claude Code セッションを「入力待ち」バッジで表示できるよう、
PermissionRequest / PostToolUse / Stop の各 hook を起点に marker ファイルを
読み書きする。

- PermissionRequest: /tmp/claude-code-manager/awaiting-input/<session_id>.json を作成
- PostToolUse / Stop: 同 marker を削除 (存在しなければ no-op)
- 例外時は他 hook を巻き込まないよう静かに失敗する
"""
import json
import os
import sys
import tempfile
from datetime import datetime, timezone

MARKER_DIR = "/tmp/claude-code-manager/awaiting-input"


def ensure_dir():
    try:
        os.makedirs(MARKER_DIR, exist_ok=True)
    except Exception:
        pass


def marker_path(session_id):
    return os.path.join(MARKER_DIR, f"{session_id}.json")


def write_atomic(path, content):
    """write-rename で atomic に書く"""
    ensure_dir()
    dir_ = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(prefix=".marker-", dir=dir_)
    try:
        with os.fdopen(fd, "w") as f:
            f.write(content)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except Exception:
            pass


def create_marker(data):
    session_id = data.get("session_id")
    if not session_id:
        return
    payload = {
        "session_id": session_id,
        "cwd": data.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR", ""),
        "tool_name": data.get("tool_name", ""),
        "tool_use_id": data.get("tool_use_id", ""),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    write_atomic(marker_path(session_id), json.dumps(payload))


def delete_marker(data):
    session_id = data.get("session_id")
    if not session_id:
        return
    try:
        os.remove(marker_path(session_id))
    except FileNotFoundError:
        pass
    except Exception:
        pass


def main():
    raw = sys.stdin.read()
    try:
        data = json.loads(raw)
    except Exception:
        return

    event = data.get("hook_event_name", "")
    if event == "PermissionRequest":
        create_marker(data)
    elif event == "PostToolUse":
        delete_marker(data)
    elif event == "Stop":
        if data.get("stop_hook_active"):
            return
        delete_marker(data)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
