// WorkBuddy Turing device-token sidecar: runs WorkBuddy's own TuringShield
// native SDK inside a real Electron main loop (the SDK refuses plain Node —
// its answer needs an app runloop), and writes the current device token to
// ~/.local/share/workbuddy-turing/token for the magpie plugin to read.
// Install with ./install.sh; remove with ./install.sh remove.
const { app } = require("electron")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

// T-Sec channel, as WorkBuddy's own cli/product.json carries it; override
// with WORKBUDDY_TURING_CHANNEL_ID if WorkBuddy's ever changes.
const CHANNEL_ID = Number(process.env.WORKBUDDY_TURING_CHANNEL_ID || 109144)
const APP = process.env.WORKBUDDY_APP || "/Applications/WorkBuddy.app"
const BINDING = APP + "/Contents/Resources/app.asar.unpacked/native/turing-sdk"
const OUT = path.join(os.homedir(), ".local/share/workbuddy-turing/token")
const REFRESH_MS = 4.5 * 60 * 1000 // the app refreshes at 5; stay ahead of it

function desktopVersion() {
  try {
    const pl = fs.readFileSync(APP + "/Contents/Info.plist", "utf8")
    const m = pl.match(/CFBundleShortVersionString<\/key>\s*<string>([\d.]+)/)
    if (m) return m[1]
  } catch {}
  return "5.9.2"
}

app.dock?.hide?.()
app.whenReady().then(async () => {
  let turing
  try {
    turing = require(BINDING + "/index.cjs")
  } catch (e) {
    return console.log("binding load failed (is WorkBuddy installed?):", String(e).slice(0, 120))
  }
  if (!turing.isSupported()) return console.log("turing unsupported on this platform")
  turing.configure(CHANNEL_ID, "WorkBuddy", desktopVersion(), true)
  const tick = async () => {
    try {
      const tok = await turing.fetchDeviceToken({ usingCachedMessage: true, includesOutdatedMessage: true, includesDeviceInfo: true, timeoutMs: 20000 })
      fs.writeFileSync(OUT, tok, { mode: 0o600 })
      console.log(new Date().toISOString(), "token refreshed, len", String(tok).length)
    } catch (e) {
      console.log(new Date().toISOString(), "refresh failed:", String(e).slice(0, 120))
    }
  }
  await tick()
  setInterval(tick, REFRESH_MS)
})
