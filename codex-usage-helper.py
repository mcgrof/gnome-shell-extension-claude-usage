#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Return Codex usage as normalized JSON for the GNOME Shell extension.

The live source is Codex App Server's read-only account/rateLimits/read
method.  A canonical local rollout snapshot is retained as a compatibility
fallback for older Codex clients.
"""

import glob
import json
import os
import select
import shutil
import subprocess
import sys
import time


CODEX_TIMEOUT = int(os.environ.get("AI_USAGE_CODEX_TIMEOUT", "3"))
CODEX_SESSIONS = os.path.expanduser("~/.codex/sessions")


def window_label(minutes):
    if not minutes or minutes <= 0:
        return ""
    if minutes % 1440 == 0:
        return "%dd" % (minutes // 1440)
    if minutes % 60 == 0:
        return "%dh" % (minutes // 60)
    return "%dm" % minutes


def codex_binary():
    configured = os.environ.get("AI_USAGE_CODEX_BIN")
    if configured:
        return configured
    found = shutil.which("codex")
    if found:
        return found
    for candidate in (
        os.path.expanduser("~/.local/bin/codex"),
        "/usr/local/bin/codex",
        "/usr/bin/codex",
    ):
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return "codex"


def app_server_read():
    """Read the live multi-bucket quota view from Codex App Server."""
    try:
        proc = subprocess.Popen(
            [codex_binary(), "app-server"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
    except Exception:
        return None

    def send(message):
        proc.stdin.write(json.dumps(message) + "\n")
        proc.stdin.flush()

    def receive(request_id, deadline):
        while time.monotonic() < deadline:
            timeout = max(0, deadline - time.monotonic())
            ready, _, _ = select.select([proc.stdout], [], [], timeout)
            if not ready:
                break
            line = proc.stdout.readline()
            if not line:
                break
            try:
                message = json.loads(line)
            except Exception:
                continue
            if message.get("id") == request_id:
                return message
        return None

    deadline = time.monotonic() + CODEX_TIMEOUT
    try:
        send({
            "method": "initialize",
            "id": 0,
            "params": {"clientInfo": {
                "name": "gnome_ai_usage",
                "title": "GNOME AI Usage",
                "version": "0.1.0",
            }},
        })
        initialized = receive(0, deadline)
        if not initialized or initialized.get("error"):
            return None
        send({"method": "initialized", "params": {}})
        send({
            "method": "account/rateLimits/read",
            "id": 6,
            "params": {},
        })
        response = receive(6, deadline)
        if not response or response.get("error"):
            return None
        return response.get("result")
    except Exception:
        return None
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=1)
        except Exception:
            try:
                proc.kill()
                proc.wait(timeout=1)
            except Exception:
                pass


def api_window(node):
    if not isinstance(node, dict) or node.get("usedPercent") is None:
        return None
    try:
        percent = float(node["usedPercent"])
        minutes = int(node.get("windowDurationMins") or 0)
        reset_ms = float(node.get("resetsAt") or 0) * 1000
    except (TypeError, ValueError):
        return None
    return {
        "pct": percent,
        "resetMs": reset_ms,
        "min": minutes,
        "label": window_label(minutes),
    }


def api_windows(limit):
    if not isinstance(limit, dict):
        return []
    windows = [window for window in (
        api_window(limit.get("primary")),
        api_window(limit.get("secondary")),
    ) if window]
    return sorted(windows, key=lambda window: window["min"])


def app_server_fetch():
    data = app_server_read()
    if not isinstance(data, dict):
        return {"ok": False, "error": "App Server unavailable"}

    buckets = data.get("rateLimitsByLimitId") or {}
    if not isinstance(buckets, dict):
        buckets = {}
    main = buckets.get("codex") or data.get("rateLimits")
    windows = api_windows(main)
    if not windows:
        return {"ok": False, "error": "No usage windows"}

    short = long = None
    if len(windows) > 1:
        short, long = windows[0], windows[-1]
    else:
        long = windows[0]

    other_limits = []
    for limit_id, limit in sorted(buckets.items(), key=lambda item: str(item[0])):
        if limit_id == "codex" or not isinstance(limit, dict):
            continue
        limit_windows = api_windows(limit)
        if limit_windows:
            other_limits.append({
                "name": limit.get("limitName") or limit_id,
                "windows": limit_windows,
            })

    reset_data = data.get("rateLimitResetCredits") or {}
    if not isinstance(reset_data, dict):
        reset_data = {}
    reset_count = reset_data.get("availableCount")
    try:
        reset_count = int(reset_count) if reset_count is not None else None
    except (TypeError, ValueError):
        reset_count = None

    reset_expiries = []
    for credit in reset_data.get("credits") or []:
        if not isinstance(credit, dict):
            continue
        if credit.get("status") == "available" and credit.get("expiresAt"):
            try:
                reset_expiries.append(float(credit["expiresAt"]) * 1000)
            except (TypeError, ValueError):
                pass

    extras = []
    if isinstance(main, dict) and main.get("planType"):
        extras.append("Plan: %s" % main["planType"])

    return {
        "ok": True,
        "short": short,
        "long": long,
        "extras": extras,
        "otherLimits": other_limits,
        "resetCredits": reset_count,
        "resetExpiries": sorted(reset_expiries),
        "liveSource": "Codex App Server",
        "staleMs": 0,
    }


def parse_timestamp(timestamp):
    if not timestamp:
        return 0
    try:
        from datetime import datetime
        return datetime.fromisoformat(timestamp.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0


def rollout_fetch():
    """Read only the canonical account-wide Codex bucket from rollouts."""
    pattern = os.path.join(CODEX_SESSIONS, "*", "*", "*", "rollout-*.jsonl")
    try:
        files = sorted(glob.glob(pattern), key=os.path.getmtime, reverse=True)
    except Exception:
        files = []

    best = None
    for path in files[:8]:
        try:
            with open(path, errors="replace") as handle:
                for line in handle:
                    if '"rate_limits"' not in line:
                        continue
                    try:
                        event = json.loads(line)
                    except Exception:
                        continue
                    limits = (event.get("payload") or {}).get("rate_limits")
                    if not isinstance(limits, dict):
                        continue
                    # Modern Codex emits separate model buckets; the plain
                    # `codex` bucket is the canonical account-wide reading.
                    if limits.get("limit_id") not in (None, "codex"):
                        continue
                    candidate = {
                        "timestamp": event.get("timestamp"),
                        "limits": limits,
                    }
                    if (best is None or
                            parse_timestamp(candidate["timestamp"]) >
                            parse_timestamp(best["timestamp"])):
                        best = candidate
        except Exception:
            continue

    if not best:
        return {"ok": False, "error": "No Codex data"}

    def legacy_window(node):
        if not isinstance(node, dict) or node.get("used_percent") is None:
            return None
        try:
            minutes = int(node.get("window_minutes") or 0)
            return {
                "pct": float(node["used_percent"]),
                "resetMs": float(node.get("resets_at") or 0) * 1000,
                "min": minutes,
                "label": window_label(minutes),
            }
        except (TypeError, ValueError):
            return None

    limits = best["limits"]
    windows = [window for window in (
        legacy_window(limits.get("primary")),
        legacy_window(limits.get("secondary")),
    ) if window]
    windows.sort(key=lambda window: window["min"])
    if not windows:
        return {"ok": False, "error": "No Codex data"}

    short = long = None
    if len(windows) > 1:
        short, long = windows[0], windows[-1]
    else:
        long = windows[0]

    extras = ["rollout fallback"]
    if limits.get("plan_type"):
        extras.insert(0, "Plan: %s" % limits["plan_type"])
    age_ms = max(0, (time.time() - parse_timestamp(best["timestamp"])) * 1000)
    return {
        "ok": True,
        "short": short,
        "long": long,
        "extras": extras,
        "otherLimits": [],
        "resetCredits": None,
        "resetExpiries": [],
        "liveSource": None,
        "staleMs": age_ms,
    }


def main():
    result = app_server_fetch()
    if not result.get("ok"):
        result = rollout_fetch()
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        sys.exit(0)
