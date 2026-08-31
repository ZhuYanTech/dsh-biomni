#!/usr/bin/env bash
#
# Build the Python environment this plugin runs against, and prove it works.
#
# The four-step recipe this replaces was the last real friction in installing
# the plugin, and its worst property was not the typing — it was that nothing
# checked the result. A venv built on Python 3.9, or one where a wheel failed
# quietly, looked exactly like a working one until the first tool call.
#
# So this script ends by running the probe and refusing to claim success unless
# the interpreter can actually import Biomni's modules. What it prints last is
# the setting to paste, with the path already filled in.
#
# Usage:
#
#   bash scripts/setup-env.sh [DIR] [--extras] [--pip]
#
#   DIR        where to build the venv (default: .venv beside this repo)
#   --extras   also install requirements-biomni-extras.txt (+494 MB, 7 functions)
#   --pip      force pip even when uv is available
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK="$HERE/python/requirements-biomni.lock.txt"
EXTRAS_FILE="$HERE/python/requirements-biomni-extras.txt"
PROBE="$HERE/python/probe.py"

TARGET=""
WANT_EXTRAS=0
FORCE_PIP=0
for arg in "$@"; do
  case "$arg" in
    --extras) WANT_EXTRAS=1 ;;
    --pip) FORCE_PIP=1 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) TARGET="$arg" ;;
  esac
done
TARGET="${TARGET:-$HERE/.venv}"

[ -f "$LOCK" ] || { echo "missing $LOCK" >&2; exit 1; }

# ── Pick an installer ────────────────────────────────────────────────────────
# uv is 11s where pip is minutes on this same lock, and the resulting
# environments were verified identical (279 of 312 functions callable either
# way). It is preferred when present and never required: a machine without it
# still gets the same environment, just slower.
if [ "$FORCE_PIP" -eq 0 ] && command -v uv >/dev/null 2>&1; then
  INSTALLER=uv
else
  INSTALLER=pip
fi

# ── Find a Python 3.11+ ──────────────────────────────────────────────────────
# Biomni's library needs 3.11. macOS ships 3.9, and the failure it produces is
# a syntax error deep in a dependency — worth catching here instead.
find_python() {
  for candidate in python3.13 python3.12 python3.11 python3 python; do
    command -v "$candidate" >/dev/null 2>&1 || continue
    if "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then
      command -v "$candidate"
      return 0
    fi
  done
  return 1
}

if [ "$INSTALLER" = uv ]; then
  # uv downloads a matching interpreter when the machine has none, which is
  # the single most common reason this step fails on macOS.
  BASE_PYTHON="(uv-managed 3.11)"
else
  BASE_PYTHON="$(find_python)" || {
    echo "No Python 3.11+ found." >&2
    echo "Biomni's library needs 3.11+; macOS ships 3.9." >&2
    echo "Install one, or install uv (https://docs.astral.sh/uv/) and re-run — uv fetches its own." >&2
    exit 1
  }
fi

echo "Building the Biomni environment"
echo "  target      $TARGET"
echo "  installer   $INSTALLER"
echo "  python      $BASE_PYTHON"
echo "  extras      $([ "$WANT_EXTRAS" -eq 1 ] && echo 'yes (+494 MB)' || echo 'no')"
echo

# ── Build ────────────────────────────────────────────────────────────────────
if [ "$INSTALLER" = uv ]; then
  uv venv --python 3.11 "$TARGET"
  PYTHON="$TARGET/bin/python"
  uv pip install --python "$PYTHON" -r "$LOCK"
  [ "$WANT_EXTRAS" -eq 1 ] && uv pip install --python "$PYTHON" -r "$EXTRAS_FILE"
else
  "$BASE_PYTHON" -m venv "$TARGET"
  PYTHON="$TARGET/bin/python"
  "$PYTHON" -m pip install --quiet --upgrade pip
  "$PYTHON" -m pip install -r "$LOCK"
  [ "$WANT_EXTRAS" -eq 1 ] && "$PYTHON" -m pip install -r "$EXTRAS_FILE"
fi

# ── Verify ───────────────────────────────────────────────────────────────────
# The point of the script. An environment that installed without error can
# still be unusable, and the probe is the same analysis the plugin itself runs,
# so a pass here means the plugin will agree.
echo
echo "Verifying..."
REPORT="$("$PYTHON" "$PROBE" 2>/dev/null || true)"

read -r OK SUMMARY <<EOF
$("$PYTHON" - "$REPORT" <<'PY'
import json, sys

try:
    report = json.loads(sys.argv[1])
except (ValueError, IndexError):
    print("no could not parse the probe output")
    raise SystemExit

if report.get("error"):
    print(f"no probe failed: {report['error']}")
elif report.get("biomni") is None:
    print("no biomni did not install into this interpreter")
else:
    modules = report.get("modules", [])
    importable = sum(1 for m in modules if m.get("importable"))
    callable_ = report.get("totalFunctions", 0) - report.get("blockedFunctions", 0)
    verdict = "yes" if importable else "no"
    print(f"{verdict} biomni {report['biomni']} · {importable}/{len(modules)} modules · "
          f"{callable_}/{report.get('totalFunctions', 0)} functions callable")
PY
)
EOF

if [ "${OK:-no}" != "yes" ]; then
  echo "  FAILED: ${SUMMARY:-unknown}" >&2
  echo >&2
  echo "The environment was built but cannot run Biomni. Run the probe directly to see why:" >&2
  echo "  $PYTHON $PROBE" >&2
  exit 1
fi

echo "  OK: $SUMMARY"
echo
echo "Point the plugin at it — Settings → Biomni, or \$DSH_HOME/settings.yaml:"
echo
echo "  biomni:"
echo "    python: $(cd "$(dirname "$PYTHON")" && pwd)/$(basename "$PYTHON")"
echo
echo "Then run /biomni in a session to see the same figures from inside the harness."
