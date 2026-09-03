# Application updates

Installed builds read `latest.json` from the latest GitHub Release. The feed
selects a signed macOS arm64 updater archive. Tauri updater signing and Apple
signing/notarization are separate required checks.

## Flow

- The main app performs one delayed automatic check. Development builds do not
  use the production feed, and automatic network failures stay silent.
- Mimir does not download before **Update** or restart before **Restart**.
- `src/stores/appUpdate.js` owns one shared state for Settings and the toast.
  Only one check, install, or restart runs at a time.
- Active download/install state cannot be dismissed. Available, ready, and
  user-requested error states can.
- Native update handles remain outside persisted Pinia state.

## Restart safety

Before relaunch, the Editor flushes content, resolves dirty documents, writes
the session, flushes Settings, and checks for active Scribe capture. The user
can cancel. A failure leaves Mimir open with the update ready to retry.

Mimir 0.1.0 cannot use the feed; users install the first updater-enabled DMG
once. Release creation and signing are documented in [building.md](building.md).
