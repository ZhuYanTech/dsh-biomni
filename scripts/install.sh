#!/usr/bin/env bash
# Install dsh-biomni into a DSH profile through the official CLI.
#
#   scripts/install.sh [profile] [python]
#
# `profile` defaults to `web`; `python` is the interpreter each session worker
# will be spawned from and defaults to leaving the setting alone. The CLI
# reconciles `dsh.profile.bundles` against installed packages and, seeing this
# package's `dsh.bundle.patch` declaration, appends `dsh-biomni` to the bundle
# stack — no profile file edits needed.
set -euo pipefail

PROFILE="${1:-web}"
PYTHON="${2:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v dsh >/dev/null 2>&1; then
  echo "dsh CLI not found on PATH. Install it first: npm i -g @deepseek-ai/dsh@0.1.0-rc.6" >&2
  exit 1
fi

echo "==> Building the plugin"
(cd "$ROOT" && pnpm install && pnpm build)

echo "==> Packing"
TARBALL="$(cd "$ROOT" && pnpm pack --silent | tail -1)"
echo "    $TARBALL"

echo "==> Installing into profile '$PROFILE'"
dsh plugin --profile "$PROFILE" add "file:$ROOT/$TARBALL"

echo "==> Verifying the layer composed"
if dsh --profile "$PROFILE" --dump-config | grep -q 'dsh-biomni'; then
  echo "    ok: dsh-biomni is in the composed configuration"
else
  echo "    WARNING: dsh-biomni did not appear in --dump-config" >&2
fi

if [ -n "$PYTHON" ]; then
  cat <<EOF

==> Point the interpreter at your Biomni venv

    Open Settings -> Biomni in the web UI and set the interpreter to:

        $PYTHON

    or write it into \$DSH_HOME/settings.yaml:

        biomni:
          python: $PYTHON
EOF
fi

cat <<EOF

Done. Start the harness with:

    dsh --profile $PROFILE

Then run /biomni in a conversation, or open Settings -> Biomni, to see what
the configured interpreter can actually do.
EOF
