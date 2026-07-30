@meetings @packaging @release @supply-chain
Feature: Ship the meeting engine as a supported and auditable desktop capability
  Production readiness is proven in the signed artifact, not inferred from a
  browser harness or development build.

  @MTG-220 @red @desktop @release @hardware
  Scenario: A clean signed macOS arm64 install can capture both channels
    Given a notarized Mimir disk image is installed on a clean Apple Silicon Mac
    And microphone and system-audio permissions have been reset
    When the user grants the permissions and records the release fixture
    Then both channels and their transcript complete inside the packaged application
    And the application passes code-signing, Gatekeeper, and notarization validation

  @MTG-221 @red @packaging @security
  Scenario: The packaged app declares only required capture capabilities
    Given the release bundle is inspected
    When entitlements, Tauri capabilities, and privacy usage descriptions are read
    Then microphone, system-audio, local-sidecar, and notification access match the implementation
    And no development-only or unrelated broad capability is present

  @MTG-222 @red @native @contract
  Scenario: Meeting schema upgrade is transactional
    Given a supported older meeting fixture exists
    When the new release migrates it
    Then the migration either commits the complete new schema or leaves the old data readable
    And audio, transcript revisions, retention, and job identity remain intact

  @MTG-223 @red @native @contract
  Scenario: A newer unsupported schema fails closed
    Given meeting data was written by a newer unsupported schema version
    When an older Mimir release opens the storage
    Then it does not write or destructively normalize the data
    And it reports the version and recovery options

  @MTG-224 @red @packaging @security @supply-chain
  Scenario: Imported source and model provenance is complete
    Given the release contains adapted anarlog code, native libraries, models, codecs, or fixtures
    When the software bill of materials and notices are generated
    Then every shipped artifact has its exact source or model version, license, digest, and modification notice
    And no artifact with unresolved or incompatible terms is shipped

  @MTG-225 @red @packaging @security
  Scenario: Model artifacts are verified at install and use
    Given a local model manifest is signed or product-pinned
    When a model is downloaded, moved, or selected
    Then Mimir verifies its digest and supported architecture before execution
    And quarantine or replacement cannot silently retain a mismatched executable model

  @MTG-226 @red @release @contract
  Scenario: Parked platforms are not advertised as supported
    Given Windows and Linux packaging remain parked
    When Mimir publishes the meeting capability
    Then release documentation claims macOS arm64 support only
    And guarded unsupported-platform code still compiles in the existing Linux CI check

  @MTG-227 @red @release @recovery
  Scenario: Disabling or rolling back meetings preserves user data
    Given meeting data exists after enabling the capability
    When the feature is disabled or the application rolls back
    Then capture and background jobs remain disabled without deleting meeting data
    And the user can inspect the compatibility status and export recoverable content

  @MTG-228 @red @release @security
  Scenario: Release evidence contains no sensitive meeting fixture
    Given packaged hardware and end-to-end checks have completed
    When their logs, screenshots, diagnostics, and artifacts are archived
    Then only licensed synthetic meeting data is present
    And no employee, participant, credential, private path, or real meeting content is retained
