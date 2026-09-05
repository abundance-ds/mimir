# Signed local Scribe smoke — 2026-07-31

This record covers a locally built, Developer ID-signed, installed test bundle.
It is not a notarized distribution artifact and is not release-candidate
evidence. It predates the company-domain migration and does not prove the
current application identity.

## Environment and identity

- Host: macOS 15.7.1 (24G231), Apple M1 Pro, arm64.
- Installed application: `/Applications/Mimir.app`.
- Bundle identifier: retired pre-migration identity.
- Signing authority: Developer ID Application, team `7WJ3GS2MUC`.
- Hardened runtime: enabled.
- Application binary SHA-256:
  `f711693efd7e59c2db248b0b527645298ff7139337631ba46d88125ea5eff88c`.
- `codesign --verify --deep --strict /Applications/Mimir.app`: pass.

## Permission and bounded audio check

Opening system-audio setup from the installed application created the Core
Audio process tap before opening System Settings. macOS displayed its native
system-audio prompt for **Mimir**. After Allow, the enabled **Mimir** row was
visible in **Privacy & Security → Screen & System Audio Recording**.

The four-second audio check was run while a known phrase was synthesized by a
separate macOS `say` process. Scribe reported **Signal detected** independently
for microphone and system audio. The check returned to Ready, retained no
samples or transcript, and the SQLite meeting count remained unchanged.

## Dual-channel local recording

The managed model was Whisper Small multilingual at pinned Hugging Face commit
`c521a4b02f422512d734391fdf08bb08c0862f68`. Its installed model SHA-256 was
reverified as
`1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b`.

Meeting `meeting-8489ea41-7c4e-471e-b875-1a2fc7d482f5` was recorded in the
signed installed application while a separate `say` process produced:

> Final signed build verification. System audio is captured and transcribed
> live. These exact words must remain visible after stop in the review
> transcript.

Observed behavior:

- Record returned immediately while the local worker initialized.
- Scribe displayed the system phrase under **Them** during recording.
- The status changed to **Transcribing live on this Mac** while words were
  visible.
- Stop completed without a crash or missing-worker error.
- Review immediately retained the same finalized phrase.
- The meeting reached durable status `completed`.

Persisted database and artifact inventory:

| Track | Committed chunks | Timeline | Example chunk SHA-256 |
|---|---:|---:|---|
| microphone | 78 | 0–78000 ms | `d95de4a7acc89cc8e4c5fd2d8fcaf656f21e1ce9fa19b037d796435604287016` |
| system | 78 | 0–78000 ms | `943aec56ba75776ab71604be1aec23d6136710fd70878391c2c11aaedd07e88b` |

The two tracks were stored under different channel paths, their terminal
coordinates were identical, all 156 chunk files were committed, and the
meeting had zero transcript-gap rows. All four system transcript segments were
final and covered 16,000–32,720 ms with speaker `Them`. The joined normalized
text SHA-256 was
`ab8a0fa3f8018a3afe935ff71499519c82b362606402a5fc13ec1e8a996d9300`.

Local transcription ran inside the signed `mimir` process. No Whisper,
transcription, or model sidecar process existed. The Mimir process had no STT
listener; its only listening TCP socket was the product's existing loopback
control endpoint. Metal cache files were owned by the retired application
identity.

## Automated verification paired with this smoke

- Frontend suite: 148 files, 1,386 tests passed.
- Rust suite: 608 library/bin tests passed, 10 CLI integration tests passed,
  and two explicitly documented manual/fixture tests remained ignored.
- Meetings native suite: 197 passed with one documented hardware-fixture test
  ignored.
- Meeting specification trace: 11 feature files, 121 scenarios, no untraced
  automated scenario.
- Frontend build, command synchronization, documentation, identity, signing,
  formatting, Clippy with warnings denied, and whitespace checks passed.

## Evidence not supplied by this run

- No real OpenAI credential was placed into Keychain, so hosted OpenAI
  transcription was not exercised against the public service. The connector
  is covered by a generated-CA TLS peer and protocol tests only.
- Interrupted-recording recovery was not exercised by killing this signed
  process during capture.
- The installed test bundle was Developer ID-signed but not notarized.
- Long-soak, device churn, sleep/wake, keyboard-only, VoiceOver, and clean-Mac
  installation procedures retain empty manual-evidence records.
