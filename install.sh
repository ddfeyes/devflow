#!/usr/bin/env bash
# Install devflow into the current user's Claude Code config (~/.claude).
# Copies the core artifacts and rewrites the engine path baked into the command.
set -euo pipefail

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$CLAUDE_DIR/commands" "$CLAUDE_DIR/workflows" "$CLAUDE_DIR/scripts"

cp "$SRC/DEVFLOW.md"            "$CLAUDE_DIR/DEVFLOW.md"
cp "$SRC/workflows/devflow.js"  "$CLAUDE_DIR/workflows/devflow.js"
cp "$SRC/commands/devflow.md"   "$CLAUDE_DIR/commands/devflow.md"

# devsync — the local↔GitHub↔server checkpoint sync (script + slash command).
cp "$SRC/scripts/devsync.sh"    "$CLAUDE_DIR/scripts/devsync.sh"
cp "$SRC/commands/devsync.md"   "$CLAUDE_DIR/commands/devsync.md"
chmod +x "$CLAUDE_DIR/scripts/devsync.sh"

# Seed local-only devsync config from the examples (never overwrite an existing real one).
[ -f "$CLAUDE_DIR/devsync.public-deny.txt" ] || cp "$SRC/devsync.public-deny.example.txt" "$CLAUDE_DIR/devsync.public-deny.txt"
[ -f "$CLAUDE_DIR/devsync.targets" ]         || cp "$SRC/devsync.targets.example"         "$CLAUDE_DIR/devsync.targets"

# The command references the engine by absolute scriptPath; point it at this install.
ENGINE="$CLAUDE_DIR/workflows/devflow.js"
sed -i -E "s#scriptPath: \"[^\"]*devflow\.js\"#scriptPath: \"$ENGINE\"#g" "$CLAUDE_DIR/commands/devflow.md"

echo "Installed devflow into $CLAUDE_DIR"
echo "  - $CLAUDE_DIR/DEVFLOW.md"
echo "  - $CLAUDE_DIR/commands/devflow.md   (scriptPath -> $ENGINE)"
echo "  - $CLAUDE_DIR/workflows/devflow.js"
echo "  - $CLAUDE_DIR/scripts/devsync.sh    (/devsync — checkpoint sync)"
echo "  - $CLAUDE_DIR/commands/devsync.md"
echo "  - $CLAUDE_DIR/devsync.targets         (edit: add your server deploy targets)"
echo "  - $CLAUDE_DIR/devsync.public-deny.txt (edit: add identifiers that must not reach public repos)"
echo
echo "Optional (auto-pull on session start): add a SessionStart hook to ~/.claude/settings.json — see README."
echo
echo "Try:  /devflow --supervised <low-stakes-repo> \"<small epic>\""
