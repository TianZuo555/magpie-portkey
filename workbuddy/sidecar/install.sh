#!/bin/bash
# Installs the WorkBuddy Turing device-token sidecar: a small Electron app
# that runs WorkBuddy's own TuringShield SDK in a real app main loop (it
# refuses plain Node) and writes the device token for the magpie plugin.
#   ./install.sh           install (or repair) and start
#   ./install.sh remove    stop and uninstall (add --purge to drop Electron)
set -euo pipefail

SIDE_DIR="$HOME/.local/share/workbuddy-turing"
LABEL="com.workbuddy.turing.sidecar"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ELECTRON_VERSION="33.4.11"   # verified working; any recent one should do
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

die() { echo "error: $*" >&2; exit 1; }

remove() {
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  if [ "${1:-}" = "--purge" ]; then rm -rf "$SIDE_DIR"; else rm -rf "$SIDE_DIR/main.js" "$SIDE_DIR/package.json"; fi
  echo "removed (token file and Electron kept unless --purge)"
  exit 0
}

[ "$(uname -s)" = "Darwin" ] || die "macOS only (the Turing SDK supports darwin and win32)"
[ "${1:-}" = "remove" ] && remove "${2:-}"
case "$(uname -m)" in
  arm64) ARCH="arm64" ;;
  x86_64) ARCH="x64" ;;
  *) die "unsupported architecture $(uname -m)" ;;
esac

WORKBUDDY_APP="${WORKBUDDY_APP:-/Applications/WorkBuddy.app}"
[ -d "$WORKBUDDY_APP/Contents/Resources/app.asar.unpacked/native/turing-sdk" ] \
  || die "WorkBuddy's Turing SDK not found at $WORKBUDDY_APP — install the WorkBuddy desktop app first"

command -v curl >/dev/null || die "curl is required"
command -v unzip >/dev/null || die "unzip is required"

mkdir -p "$SIDE_DIR"
cp "$SRC_DIR/main.js" "$SIDE_DIR/main.js"
cat > "$SIDE_DIR/package.json" << 'EOF'
{ "name": "workbuddy-turing-sidecar", "version": "1.0.0", "main": "main.js" }
EOF

# Electron is ~100 MB; keep an existing good copy, replace a broken one
if [ ! -x "$SIDE_DIR/Electron.app/Contents/MacOS/Electron" ] || \
   [ ! -d "$SIDE_DIR/Electron.app/Contents/Frameworks" ]; then
  echo "downloading Electron v$ELECTRON_VERSION (darwin-$ARCH)…"
  TMP_ZIP="$(mktemp -d)/electron.zip"
  curl -fSL --progress-bar "https://github.com/electron/electron/releases/download/v$ELECTRON_VERSION/electron-v$ELECTRON_VERSION-darwin-$ARCH.zip" -o "$TMP_ZIP"
  rm -rf "$SIDE_DIR/Electron.app"
  TMP_DIR="$(mktemp -d)"
  unzip -q "$TMP_ZIP" -d "$TMP_DIR"
  mv "$TMP_DIR/Electron.app" "$SIDE_DIR/Electron.app"
  xattr -dr com.apple.quarantine "$SIDE_DIR/Electron.app" 2>/dev/null || true
  [ -d "$SIDE_DIR/Electron.app/Contents/Frameworks" ] || die "Electron extraction incomplete — run again"
fi

cat > "$PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$SIDE_DIR/Electron.app/Contents/MacOS/Electron</string>
    <string>$SIDE_DIR</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>WORKBUDDY_APP</key><string>$WORKBUDDY_APP</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$SIDE_DIR/sidecar.log</string>
  <key>StandardErrorPath</key><string>$SIDE_DIR/sidecar.log</string>
</dict></plist>
EOF

UID_="$(id -u)"
launchctl bootout "gui/$UID_/$LABEL" 2>/dev/null || true
sleep 2
launchctl bootstrap "gui/$UID_" "$PLIST" 2>/dev/null || launchctl kickstart -k "gui/$UID_/$LABEL" || die "could not start the LaunchAgent"

echo "started; waiting for the first token…"
for i in $(seq 1 30); do
  [ -s "$SIDE_DIR/token" ] && break
  sleep 1
done
if [ -s "$SIDE_DIR/token" ]; then
  echo "OK: $(wc -c < "$SIDE_DIR/token" | tr -d ' ')-byte token at $SIDE_DIR/token"
  echo "The plugin (>= 0.1.38) picks it up on its next chat."
else
  echo "no token yet — check $SIDE_DIR/sidecar.log (first fetch can take a moment; run again to retry)"
fi
