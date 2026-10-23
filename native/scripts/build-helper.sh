#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PACKAGE_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
OUTPUT_DIR=${1:-"$PACKAGE_DIR/.build"}
PLIST_PATH="$PACKAGE_DIR/helper/ContextMacOSPIMHelper-Info.plist"
ENTITLEMENTS_PATH="$PACKAGE_DIR/helper/ContextMacOSPIMHelper.entitlements"
APP_PATH="$OUTPUT_DIR/Context macOS PIM Helper.app"
CONTENTS_PATH="$APP_PATH/Contents"
OUTPUT_PATH="$CONTENTS_PATH/MacOS/context-macos-pim-helper"
SIGNING_IDENTITY="${SOURCE_SEARCH_SIGNING_IDENTITY:?Set your own code-signing identity}"
BUNDLE_ID="${SOURCE_SEARCH_BUNDLE_ID:?Set your own reverse-domain helper bundle identifier}"

mkdir -p "$CONTENTS_PATH/MacOS"
plutil -lint "$PLIST_PATH" >/dev/null
plutil -lint "$ENTITLEMENTS_PATH" >/dev/null
install -m 0644 "$PLIST_PATH" "$CONTENTS_PATH/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" "$CONTENTS_PATH/Info.plist"
swiftc \
  -swift-version 5 \
  -parse-as-library \
  -O \
  -module-cache-path "$OUTPUT_DIR/module-cache" \
  -framework EventKit \
  -framework Contacts \
  -framework AppKit \
  -Xlinker -sectcreate \
  -Xlinker __TEXT \
  -Xlinker __info_plist \
  -Xlinker "$CONTENTS_PATH/Info.plist" \
  "$PACKAGE_DIR/helper/ContextMacOSPIMHelper.swift" \
  -o "$OUTPUT_PATH"

# The disclaim shim spawns the helper with a clean TCC responsibility slate so
# macOS attributes the Calendar/Contacts prompt to the helper itself, not to
# the launching terminal/launchd (which lacks the privacy entitlements).
cc -O2 -Wall -Wextra \
  "$PACKAGE_DIR/helper/context-macos-pim-disclaim.c" \
  -o "$OUTPUT_DIR/context-macos-pim-disclaim"

codesign --force --deep --sign "$SIGNING_IDENTITY" --identifier "$BUNDLE_ID" --entitlements "$ENTITLEMENTS_PATH" --timestamp=none "$APP_PATH" >/dev/null
codesign --verify --deep --strict "$APP_PATH"

printf '%s\n' "$OUTPUT_PATH"
