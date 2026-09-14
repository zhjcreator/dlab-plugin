#!/usr/bin/env bash
#
# Install the 深度学习实验 agent preset from this checkout into the harness
# home, where DSH discovers locally authored presets.
#
#     scripts/install-preset.sh [preset-id]
#
# DSH scans `$DSH_HOME/.agent-presets/<id>/` and takes the directory name as
# the preset id (default `dlab`). Discovery only accepts real directories — a
# symlink to the checkout is NOT found — and the preset's bundled `skills/`
# root is resolved relative to the installed copy, so this copies the
# deployable files rather than linking them.
#
# Any content already at that id is backed up under
# `$DSH_HOME/backups/agent-presets/` (outside the scanned root, so the backup
# never shows up as a broken preset) before it is replaced.
#
# A running Host keeps the composition a preset was mounted with; restart
# `dsh web` (or start a session after it restarts) to mount the new copy.

set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$repo/packages/preset-lab"
id="${1:-dlab}"
home="${DSH_HOME:-$HOME/.dsh}"
dest="$home/.agent-presets/$id"

case "$id" in
  ''|*[!a-z0-9-]*|[!a-z0-9]*) echo "invalid preset id: $id" >&2; exit 1 ;;
esac

for file in agent.cordis.yml preset.yml; do
  [ -f "$src/$file" ] || { echo "missing preset source: $src/$file" >&2; exit 1; }
done

if [ -e "$dest" ]; then
  backup="$home/backups/agent-presets/$id-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$(dirname "$backup")"
  cp -r "$dest" "$backup"
  echo "backed up $dest -> $backup"
fi

rm -rf "$dest"
mkdir -p "$dest"
cp "$src/agent.cordis.yml" "$src/preset.yml" "$dest/"
cp -r "$src/skills" "$dest/skills"

echo "installed preset '$id' -> $dest"
echo "restart dsh web to mount it."
