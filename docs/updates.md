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
- The toast cannot be dismissed while checking, downloading, installing, or
  restarting.
- The native update handle stays in a store closure, not in reactive state.

## Restart safety

Restart runs the renderer part of the [Quit](runtime-architecture.md#quit)
sequence (`completeNativeQuit` in `src/editor/appQuit.js`): close guard without
native close, Settings flush, confirmation if Scribe records. It ends with
`app_prepare_relaunch`, not `app_quit_confirmed`. Cancel or failure leaves Mimir
open with the update ready.

Release creation and signing: [building.md](building.md).
