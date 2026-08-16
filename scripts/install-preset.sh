#!/usr/bin/env bash
# Install the "生物医学模式" agent preset into $DSH_HOME/.agent-presets/biomni.
#
#   bash scripts/install-preset.sh
#
# WHY THIS GENERATES RATHER THAN SHIPS A COMPOSITION
#
# A preset's agent.cordis.yml is a COMPLETE composition — there is no `extends`.
# Vendoring a copy of the shipped `standard` preset into this repository would
# freeze one dsh version's row list and drift silently from every later one, and
# the symptom of that drift is an agent quietly missing a tool.
#
# So the preset is assembled at install time from the standard preset in YOUR
# harness: its rows are copied verbatim and only the persona is replaced. What
# you get always matches the dsh you actually run.
#
# WHAT THIS PRESET DOES *NOT* DO
#
# It does not mount dsh-biomni. It cannot: a bare specifier in a preset row
# resolves from the INSTALLED HARNESS, not from the profile's node_modules
# (@deepseek-ai/dsh-agent-presets, PresetTree.import), and a relative path would
# leave this plugin's own dependencies unresolvable from a preset directory.
#
# The division is therefore:
#   * the profile bundle carries the capability — run_python, the settings page,
#     the skill catalog (`bash scripts/install.sh web`, or `dsh plugin add
#     dsh-biomni` once published);
#   * this preset carries the FRAMING, scoped per agent.
#
# Because the framing moves here, set `guidance: ''` on the plugin's profile row
# so the same text does not also ride every other agent on the profile. See the
# README section "Bundle or preset".
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PRESET_ID="${1:-biomni}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
TARGET="$DSH_HOME_DIR/.agent-presets/$PRESET_ID"

command -v dsh >/dev/null 2>&1 || {
  echo "dsh CLI not found on PATH. Install it first: npm i -g @deepseek-ai/dsh@0.1.0-rc.6" >&2
  exit 1
}

# The harness package root, from the resolved `dsh` executable:
#   <pkg>/lib/bin.js  <-  node_modules/.bin/dsh symlink
DSH_BIN="$(command -v dsh)"
while [ -L "$DSH_BIN" ]; do
  LINK="$(readlink "$DSH_BIN")"
  case "$LINK" in
    /*) DSH_BIN="$LINK" ;;
    *)  DSH_BIN="$(cd "$(dirname "$DSH_BIN")" && cd "$(dirname "$LINK")" && pwd)/$(basename "$LINK")" ;;
  esac
done
HARNESS="$(cd "$(dirname "$DSH_BIN")/.." && pwd)"
STANDARD="$HARNESS/config/agent-presets/standard/agent.cordis.yml"

[ -f "$STANDARD" ] || {
  echo "Could not find the standard preset at:" >&2
  echo "  $STANDARD" >&2
  echo "(resolved the harness to $HARNESS from $DSH_BIN)" >&2
  echo "Your dsh layout may differ; copy the preset by hand, replacing its persona row." >&2
  exit 1
}
echo "==> standard preset: $STANDARD"

mkdir -p "$TARGET"
cp "$ROOT/preset/preset.yml" "$TARGET/preset.yml"

# Replace the persona row's `text:` block with ours, leaving every other row of
# the standard composition untouched.
python3 - "$STANDARD" "$ROOT/preset/persona.md" "$TARGET/agent.cordis.yml" <<'PY'
import sys

standard_path, persona_path, out_path = sys.argv[1:4]
standard = open(standard_path, encoding='utf-8').read().splitlines()
persona = open(persona_path, encoding='utf-8').read().rstrip('\n')

out, index, replaced = [], 0, False
while index < len(standard):
    line = standard[index]
    # The persona row: `- id: persona`, whose config.text block scalar is the
    # only thing this preset changes.
    if line.strip() == '- id: persona':
        out.append(line)
        index += 1
        # Copy the row through to its `text:` key.
        while index < len(standard) and standard[index].strip() != 'text: >-' \
                and not standard[index].strip().startswith('text:'):
            out.append(standard[index])
            index += 1
        if index >= len(standard):
            break
        indent = len(standard[index]) - len(standard[index].lstrip())
        out.append(' ' * indent + 'text: |-')
        for paragraph_line in persona.split('\n'):
            out.append((' ' * (indent + 2) + paragraph_line).rstrip())
        index += 1
        # Skip the original block scalar: everything indented deeper than `text:`.
        while index < len(standard):
            candidate = standard[index]
            if candidate.strip() == '':
                index += 1
                continue
            if len(candidate) - len(candidate.lstrip()) > indent:
                index += 1
                continue
            break
        out.append('')
        replaced = True
        continue
    out.append(line)
    index += 1

if not replaced:
    sys.exit('the standard preset has no `- id: persona` row; refusing to write a preset '
             'whose persona is the deployment default')

open(out_path, 'w', encoding='utf-8').write('\n'.join(out).rstrip('\n') + '\n')
PY

echo "==> installed to $TARGET"
echo
echo "Next:"
echo "  1. Install the capability as a profile bundle, if you have not:"
echo "       bash scripts/install.sh web      # or, once published:"
echo "       dsh plugin --profile web add dsh-biomni"
echo "  2. Silence the profile-wide prompt section, so the framing lives only in"
echo "     this preset — in \$DSH_HOME/profiles/web/cordis.patch.yml:"
echo "       - id: biomni"
echo "         config:"
echo "           guidance: ''"
echo "  3. Boot, create a session, and pick 生物医学模式."
