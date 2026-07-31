# Signed Scribe settings smoke — 2026-08-01

This record covers a locally built, Developer ID-signed, installed test bundle.
It is not a notarized distribution artifact and is not release-candidate
evidence.

## Environment and identity

- Host: macOS 15.7.1 (24G231), arm64.
- Installed application: `/Applications/Mimir.app`.
- Bundle identifier: `rs.shoulde.mimir`.
- Signing authority: Developer ID Application, team `7WJ3GS2MUC`.
- Hardened runtime: enabled.
- Application binary SHA-256:
  `1e09027352dab692d554d80e4db3916866ed6bbef2845285dd94aefb996ac018`.
- `codesign --verify --deep --strict /Applications/Mimir.app`: pass.

## Native Keychain credential lifecycle

The signed installed application was switched temporarily from Local model to
Hosted. Before the test, the Scribe credential query returned no entry. A
disposable, non-service credential was entered through Scribe settings.

Observed behavior:

- Save remained unavailable until the field contained input.
- Save returned **API key saved and verified in Keychain**.
- The field cleared only after that confirmation.
- The persistent state changed to **Saved in Keychain · ready to use** and
  exposed **Replace key** and **Remove key**.
- A metadata-only `security find-generic-password` query found the native
  `rs.shoulde.mimir` / `meetings.custom-stt` entry; its secret was never read by
  the verification procedure.
- Leaving and reopening Scribe settings retained the saved state and controls.
- Remove returned **API key removed from Keychain** and the metadata query again
  reported no entry.
- The test restored Local model before completion.

This smoke exposed and verified the repair for the former failure: `keyring`
had been compiled without `apple-native`, causing macOS builds to select the
crate's in-memory mock. The native backend is now an explicit build feature,
and Scribe additionally requires endpoint-bound read-back before reporting
success.

## Bounded audio strength feedback

Scribe's four-second audio check ran while a separate macOS `say` process
produced a known phrase. The signed application displayed independent bounded
strength bars and **Signal detected** for microphone and system audio. Samples
were discarded after the check; no meeting or transcript was created.

## Summary recipe controls

Settings displayed independent **Summary format** and **CLI agent** controls.
A completed meeting's Summary review displayed the same pair beneath **Create
summary again**, plus a deliberate **Create again** action. The action itself
was not pressed during this smoke, avoiding an unintended external CLI-agent
run; durable rerun behavior is covered by native and renderer tests.

## Evidence not supplied by this run

- No real hosted API credential or public-service request was used.
- The native meeting-detection notification was not forced during this run.
- The bundle was signed but not notarized.
