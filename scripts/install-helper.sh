#!/bin/bash
# Builds helper/CapCutSyncHelper.js into "CapCut Sync Helper.app" (default: ~/Applications).
# macOS ties Accessibility and Automation permissions to the exact build, so this skips the rebuild
# when the source hasn't changed. Pass --force to rebuild anyway (you'll have to allow it again).
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)/helper/CapCutSyncHelper.js"
DEST="${CAPCUT_SYNC_HELPER:-$HOME/Applications/CapCut Sync Helper.app}"
BUNDLE_ID="local.capcut-mcp.sync-helper"
STAMP="$DEST/Contents/Resources/source.sha256"
SUM="$(shasum -a 256 "$SRC" | cut -d' ' -f1)"

if [[ "${1:-}" != "--force" && -f "$STAMP" && "$(cat "$STAMP")" == "$SUM" ]]; then
  echo "CapCut Sync Helper is already up to date at $DEST (permissions kept)."
  exit 0
fi

mkdir -p "$(dirname "$DEST")" "$HOME/Library/Application Support/CapCut Sync Helper"
TMP="$(mktemp -d)/CapCut Sync Helper.app"
osacompile -l JavaScript -o "$TMP" "$SRC"

PLIST="$TMP/Contents/Info.plist"
plutil -replace CFBundleIdentifier -string "$BUNDLE_ID" "$PLIST"
plutil -replace CFBundleName -string "CapCut Sync Helper" "$PLIST"
plutil -replace LSUIElement -bool true "$PLIST"
plutil -replace NSAppleEventsUsageDescription -string "CapCut Sync Helper clicks CapCut's menus so the CapCut MCP server can sync edits without quitting CapCut." "$PLIST"
echo "$SUM" > "$TMP/Contents/Resources/source.sha256"
codesign --force --deep --sign - "$TMP"

REBUILT=0; [[ -d "$DEST" ]] && REBUILT=1
rm -rf "$DEST"
mv "$TMP" "$DEST"
echo "Installed CapCut Sync Helper at $DEST"
echo "Allow it under System Settings > Privacy & Security > Accessibility, and let it control System Events when asked."
if [[ $REBUILT == 1 ]]; then
  echo "This replaced an older build, so its old Accessibility entry no longer matches: remove it with '-' and add the app again with '+'."
fi
