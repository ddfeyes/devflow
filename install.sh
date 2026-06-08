#!/usr/bin/env bash
# Install devflow into the current user's Claude Code config (~/.claude).
# Copies the three artifacts and rewrites the engine path baked into the command.
set -euo pipefail

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$CLAUDE_DIR/commands" "$CLAUDE_DIR/workflows"

cp "$SRC/DEVFLOW.md"            "$CLAUDE_DIR/DEVFLOW.md"
cp "$SRC/workflows/devflow.js"  "$CLAUDE_DIR/workflows/devflow.js"
cp "$SRC/commands/devflow.md"   "$CLAUDE_DIR/commands/devflow.md"

# The command references the engine by absolute scriptPath; point it at this install.
ENGINE="$CLAUDE_DIR/workflows/devflow.js"
sed -i -E "s#scriptPath: \"[^\"]*devflow\.js\"#scriptPath: \"$ENGINE\"#g" "$CLAUDE_DIR/commands/devflow.md"

echo "Installed devflow into $CLAUDE_DIR"
echo "  - $CLAUDE_DIR/DEVFLOW.md"
echo "  - $CLAUDE_DIR/commands/devflow.md   (scriptPath -> $ENGINE)"
echo "  - $CLAUDE_DIR/workflows/devflow.js"
echo
echo "Try:  /devflow --supervised <low-stakes-repo> \"<small epic>\""
