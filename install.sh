#!/bin/bash
# Install the Claude Usage GNOME Shell extension
set -e

EXT_UUID="claude-usage@tasta.space"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"

echo "Installing AI Usage extension..."

# Compile schemas
glib-compile-schemas --strict "$(dirname "$0")/schemas/"

# Remove old version if present
rm -rf "$EXT_DIR"

# Copy extension files
mkdir -p "$EXT_DIR"
cp -r "$(dirname "$0")"/{metadata.json,extension.js,prefs.js,stylesheet.css,codex-usage-helper.py,schemas,icons} "$EXT_DIR/"
chmod +x "$EXT_DIR/codex-usage-helper.py"

echo "Installed to $EXT_DIR"
echo ""
echo "Enable with:"
echo "  gnome-extensions enable $EXT_UUID"
echo "If GNOME has not discovered a first-time install yet, log out and back in."
echo ""
echo "The extension auto-reads your Claude Code OAuth token from:"
echo "  ~/.claude/.credentials.json"
echo "Codex usage is queried live through:"
echo "  codex app-server"
echo ""
echo "If you don't use Claude Code, open extension preferences to set the token manually."
