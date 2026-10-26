# Turing device-token sidecar

`X-Device-Token` is minted by WorkBuddy's TuringShield anti-fraud SDK
(`WorkBuddy.app/…/native/turing-sdk`), five minutes at a time. The SDK only
answers inside a real app main loop — plain Node, Bun and even
`ELECTRON_RUN_AS_NODE` never see its answer (verified 2026-10-26) — so this
sidecar runs it in a real (unsigned, downloaded) Electron and writes the
token to `~/.local/share/workbuddy-turing/token`. The plugin (>= 0.1.38)
sends it when the file is less than ten minutes old; with no sidecar there
is no header, and WorkBuddy's servers serve chats without it either.

- The token is bound to this machine's hardware fingerprint — each machine
  installs its own sidecar (macOS; the SDK also supports Windows, this
  sidecar doesn't yet).
- WorkBuddy's desktop app must be installed; the sidecar loads its SDK.

```
./install.sh            # download Electron (~100 MB, once), start, verify
./install.sh remove     # stop and uninstall (--purge drops Electron too)
```

Runs as the LaunchAgent `com.workbuddy.turing.sidecar` (KeepAlive, refresh
every 4.5 min). Log: `~/.local/share/workbuddy-turing/sidecar.log`.
Override the app path with `WORKBUDDY_APP=/path WorkBuddy.app ./install.sh`.
