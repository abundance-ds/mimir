# Application updates

This document owns installed-app update behavior, UI states, security, and
restart safety. [building.md](building.md) owns release operations.

## Contract

Mimir checks this public static feed:

`https://github.com/shoulders-ai/mimir/releases/latest/download/latest.json`

The feed selects the signed macOS arm64 updater archive. The application
contains only the updater public key. GitHub Actions holds the private key and
password.

Updater signing is separate from Apple Developer ID signing and notarization.
Both checks must pass. The updater signature proves that Mimir produced the
archive. Apple signing and notarization prove the macOS application identity.

## Automatic check

`src/mimir/App.vue` starts one delayed check after the main workbench mounts.
Development and browser builds do not check the production feed.

An automatic failure is silent. A temporary network failure must not interrupt
startup. When an update exists, the update toast appears. Mimir does not
download until the user selects **Update**. Mimir does not restart until the
user selects **Restart**.

The user can dismiss an available or ready toast for the current process. A
download or install toast cannot be dismissed because it is the visible status
for active work.

## Shared state

`src/stores/appUpdate.js` owns the update state. The toast and Settings read
the same store. One check, install, or restart can run at a time.

| State | Meaning | Primary action |
|---|---|---|
| `idle` | no check result in this process | Check for updates |
| `checking` | feed request is active | none |
| `current` | installed version is newest | Check again |
| `available` | a newer signed release exists | Update |
| `downloading` | archive transfer is active | none |
| `installing` | archive verification and install are active | none |
| `ready` | update is installed | Restart Mimir |
| `restarting` | save and relaunch sequence is active | none |
| `error` | manual check, install, or restart failed | Try again |
| `unsupported` | browser or development build | none |

The store keeps the native Tauri Update handle outside persisted state. It
reports only serializable version, progress, note, and error data to Vue.

## Settings

The **Updates** section uses one stable version handoff:

`v0.2.0 → v0.2.1`

The status and action change in place. This prevents layout movement while the
check or download runs. A known content length gives percentage progress. An
unknown length gives an indeterminate working indicator.

Errors use a short recovery instruction. Technical detail remains available
in a disclosure control. The region uses live status semantics. It does not
move focus when state changes.

The macOS application menu opens this section through **Check for Updates…**.

## Toast

`src/shared/ui/UpdateToast.vue` mounts once beside the workbench. It covers
only these states:

- update available;
- downloading or installing;
- ready to restart;
- user-initiated failure.

The toast uses the same action words as Settings. It uses existing Mimir
tokens and Tabler icons. Reduced-motion mode removes spinner and entrance
animation.

## Restart safety

The updater cannot call relaunch directly. `src/editor/App.vue` registers the
restart guard from `useEditorNativeLifecycle.js`.

Before relaunch, the guard:

1. flushes the current editor content;
2. resolves each modified document through the normal close decision;
3. writes the editor session;
4. flushes Settings;
5. detects active Scribe capture;
6. asks before it stops and preserves a recording;
7. calls `app_prepare_relaunch`;
8. permits the Tauri process plug-in to relaunch.

If the user cancels or a write fails, the app stays open and the update stays
ready.

## First rollout

Mimir 0.1.0 cannot read this feed. Each user installs Mimir 0.2.0 from its DMG
once. Later versions update inside Mimir.

The next real release must confirm:

- the automatic toast finds it;
- Settings reports the same version and progress;
- the signature check accepts the archive;
- restart uses the document and recording guards;
- About reports the new installed version after restart.
