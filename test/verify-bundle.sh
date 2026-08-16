#!/usr/bin/env bash
# End-to-end mount verification: install the PUBLISHED ARTIFACT into an
# isolated profile, boot it, and check that every seam this plugin owns is
# actually live.
#
#   bash test/verify-bundle.sh
#
# Needs `dsh` on PATH (pin 0.1.0-rc.6), pnpm, git, and network on first run.
# Everything happens under a temporary $DSH_HOME, so a real ~/.dsh and a
# running Web GUI are never touched.
#
# Three implementation notes, each of which cost someone an afternoon:
#
#   * Install through `git+file://` rather than the tarball path. pnpm applies
#     supply-chain acceptance checks to registry-shaped specifiers, and an
#     unpublished package fails them; a local git remote sidesteps that. Once
#     published, `dsh plugin add dsh-biomni` is the real command.
#   * Pin the webserver port in $DSH_HOME/cordis.patch.yml. The default 3080
#     collides with any Web GUI already running, and the failure looks like a
#     plugin fault rather than a port clash.
#   * Never swallow `dsh plugin add` output. When it fails it fails verbosely,
#     and hiding that turns a five-minute fix into an hour.
#
# Credit: the isolation recipe is adapted from dsh-science's test/verify-bundle.sh
# (https://github.com/biociao/dsh-science, MIT).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d /tmp/dsh-biomni-verify-XXXXXX)"
GIT_DIR="$TMP/repo"
PROFILE="${VERIFY_PROFILE:-web}"
# A high fixed port: the route probe needs to know where to knock, and port 0
# would leave us parsing it out of a log line whose format is not a contract.
PORT="${VERIFY_PORT:-39080}"
PYTHON="${DSH_BIOMNI_PYTHON:-python3}"

export DSH_HOME="$TMP/home"
trap 'rm -rf "$TMP"' EXIT

step() { printf '\n== %s ==\n' "$1"; }
ok()   { printf '   ✓ %s\n' "$1"; }
die()  { printf '   ✗ %s\n' "$1" >&2; exit 1; }

step "1/8 package structure"
for required in package.json cordis.patch.yml dsh.plugin.json python/worker.py python/probe.py python/skills.py; do
  [ -f "$ROOT/$required" ] || die "missing $required"
done
ok "sources present"

step "2/8 build and pack (the published artifact, not the working tree)"
( cd "$ROOT" && pnpm install --silent && pnpm build >/dev/null )
( cd "$ROOT" && pnpm pack --pack-destination "$TMP" >/dev/null )
TGZ="$(ls "$TMP"/*.tgz | head -1)"
ok "packed $(basename "$TGZ")"
# The host resolves these at runtime from the package root; a files[] slip
# would only surface as a spawn failure inside a session.
for asset in python/worker.py python/probe.py python/skills.py python/_gates.py lib/index.js lib/client.js lib/client-registry.js; do
  tar -tzf "$TGZ" | grep -q "^package/$asset$" || die "tarball is missing $asset"
done
ok "runtime assets ship in the tarball"

step "3/8 local git remote (dodges pnpm supply-chain checks on unpublished packages)"
git init -q "$GIT_DIR"
tar -xzf "$TGZ" -C "$TMP"
cp -R "$TMP/package/." "$GIT_DIR/"
git -C "$GIT_DIR" add -A
git -C "$GIT_DIR" -c user.name=verify -c user.email=verify@local commit -qm verify
ok "git remote prepared from the packed contents"

step "4/8 install into an isolated profile"
mkdir -p "$DSH_HOME"
cat > "$DSH_HOME/cordis.patch.yml" <<EOF
# Verification only: pin the port so the route probe knows where to knock and
# a running Web GUI on 3080 is never disturbed.
#
# \`host\` is restated because a patch row REPLACES the row's config rather than
# merging into it — omitting it fails validation with "\$.host missing required
# value", which reads like a plugin fault and is not one.
- id: webserver
  config:
    host: 127.0.0.1
    port: $PORT
EOF
ADD_OUT="$(dsh plugin --profile "$PROFILE" add "git+file://$GIT_DIR" 2>&1 || true)"
echo "$ADD_OUT" | tail -8
python3 - "$DSH_HOME/profiles/$PROFILE/package.json" <<'PY'
import json, sys
bundles = json.load(open(sys.argv[1])).get("dsh", {}).get("profile", {}).get("bundles", [])
assert "dsh-biomni" in bundles, f"dsh-biomni did not join the bundle stack: {bundles}"
PY
ok "dsh-biomni joined dsh.profile.bundles"

step "5/8 composition (--dump-config)"
DUMP="$(dsh --profile "$PROFILE" --dump-config 2>&1 || true)"
echo "$DUMP" | grep -q 'dsh-biomni' || die "the dsh-biomni row did not merge into the composition"
ok "the dsh-biomni row merged"

step "6/8 boot"
# Point the interpreter at whatever the caller configured, through the same
# settings document a user would edit.
mkdir -p "$DSH_HOME"
cat > "$DSH_HOME/settings.yaml" <<EOF
biomni:
  python: $PYTHON
EOF
BOOT_LOG="$TMP/boot.log"
dsh --profile "$PROFILE" >"$BOOT_LOG" 2>&1 &
BOOT_PID=$!
# shellcheck disable=SC2064
trap "kill $BOOT_PID 2>/dev/null || true; rm -rf '$TMP'" EXIT

for _ in $(seq 1 60); do
  curl -sf -o /dev/null "http://127.0.0.1:$PORT/" && break
  kill -0 "$BOOT_PID" 2>/dev/null || { echo "--- boot log ---"; tail -30 "$BOOT_LOG"; die "the harness exited during boot"; }
  sleep 1
done
curl -sf -o /dev/null "http://127.0.0.1:$PORT/" || { echo "--- boot log ---"; tail -30 "$BOOT_LOG"; die "the harness never served on port $PORT"; }
if grep -qiE 'dsh-biomni.*(error|failed)|(error|failed).*dsh-biomni' "$BOOT_LOG"; then
  echo "--- plugin errors in the boot log ---"
  grep -iE 'dsh-biomni' "$BOOT_LOG" | head -10
  die "the plugin logged an error during load or apply"
fi
ok "booted with no dsh-biomni load or apply error"

step "7/8 the seams this plugin owns"

# The settings route. This is the whole reason the plugin serves its own API:
# DSH's settings RPC filters third-party namespaces through a hardcoded
# allowlist, so a card built on that RPC would read nothing here.
SETTINGS="$(curl -sf -X POST "http://127.0.0.1:$PORT/biomni/api/settings.get" \
  -H 'content-type: application/json' -d '{}' || true)"
echo "$SETTINGS" | grep -q '"ok":true' || die "/biomni/api/settings.get did not answer: ${SETTINGS:-<no response>}"
echo "$SETTINGS" | grep -q "$PYTHON" || die "settings.get did not resolve the configured interpreter: $SETTINGS"
ok "settings.get answers and resolves the settings document"

# The trust fence: a cross-site Host header must be refused.
FORBIDDEN="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  "http://127.0.0.1:$PORT/biomni/api/settings.get" \
  -H 'content-type: application/json' -H 'Host: evil.example.com' -d '{}' || true)"
[ "$FORBIDDEN" = "403" ] || die "the trust fence let an untrusted Host through (got $FORBIDDEN)"
ok "the trust fence refuses an untrusted Host"

# The environment probe, end to end through the route.
PROBE="$(curl -sf -X POST "http://127.0.0.1:$PORT/biomni/api/env.probe" \
  -H 'content-type: application/json' -d '{}' --max-time 120 || true)"
echo "$PROBE" | grep -q '"ok":true' || die "/biomni/api/env.probe did not answer: ${PROBE:-<no response>}"
ok "env.probe answers"
if echo "$PROBE" | grep -q '"biomni":null'; then
  printf '   · note: %s has no Biomni, so the probe reports an empty inventory\n' "$PYTHON"
  printf '     (set DSH_BIOMNI_PYTHON to a Biomni venv to verify the catalog too)\n'
else
  ok "the probe found Biomni in $PYTHON"
fi

step "8/8 the browser half"
# The shell's boot manifest lists every plugin client bundle it will load. A
# bundle whose registered id does not match its channel simply never
# activates, with no error anywhere — so the id is checked against the served
# artifact, not just against the file on disk.
curl -sf "http://127.0.0.1:$PORT/client-modules" -o "$TMP/client-modules.html" \
  || die "the shell did not serve its boot manifest"
python3 - "$TMP/client-modules.html" "$TMP/entry.json" <<'PY'
import json, sys
html = open(sys.argv[1]).read()
marker = 'window.__DSH_BOOT__ = '
start = html.index(marker) + len(marker)
depth = 0
for end in range(start, len(html)):
    if html[end] == '{':
        depth += 1
    elif html[end] == '}':
        depth -= 1
        if depth == 0:
            break
boot = json.loads(html[start:end + 1])
hit = [entry for entry in boot['entries'] if entry['id'] == 'dsh-biomni']
assert hit, f"dsh-biomni is not in the shell's boot manifest ({len(boot['entries'])} entries)"
json.dump(hit[0], open(sys.argv[2], 'w'))
PY
ok "the shell will load the dsh-biomni client bundle"

BUNDLE_URL="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["url"])' "$TMP/entry.json")"
curl -sf "http://127.0.0.1:$PORT$BUNDLE_URL" -o "$TMP/served-client.js" \
  || die "the client bundle URL from the manifest does not serve"
cmp -s "$TMP/served-client.js" "$ROOT/lib/client.js" \
  || die "the served bundle differs from the built lib/client.js"
grep -q 'settings.section' "$TMP/served-client.js" || die "the served bundle registers no settings section"
ok "the served bundle is byte-identical to lib/client.js and registers a settings section"

printf '\n✔ all checks passed. Isolated environment removed.\n'
printf '\nStill unverified without a browser: how the Settings section RENDERS,\n'
printf 'and whether a live session lists the biomni-* skills.\n'
