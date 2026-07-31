@meetings @transcription
Feature: Produce live and batch transcripts through local or custom routes
  Transcription is revisioned, bounded, recoverable, and subordinate to the
  authoritative recording.

  @MTG-060 @automated @domain @contract
  Scenario: Provisional words can be revised before they become final
    Given a live provider has emitted a provisional segment
    When the provider emits a later revision for the same segment identity
    Then Mimir replaces only the provisional projection
    And the final segment retains stable audio-time provenance

  @MTG-061 @automated @domain @contract
  Scenario: Duplicate and out-of-order provider messages are idempotent
    Given transcript deltas carry provider sequence and segment identities
    When duplicate and out-of-order deltas arrive
    Then the canonical transcript contains each accepted revision once
    And stale deltas cannot rewrite a newer final revision

  @MTG-062 @automated @native @contract
  Scenario: Renderer notifications reconcile from authoritative transcript snapshots
    Given native transcription accepts revisioned partial and final batches
    When renderer notifications arrive late, duplicate, or after a reload
    Then the renderer accepts only authoritative monotonic snapshots
    And the durable final transcript preserves the complete accepted text

  @MTG-063 @automated @native @recovery
  Scenario: Live transcription failure degrades to delayed transcription
    Given recording and live transcription are active
    When the live route fails but recording remains healthy
    Then recording continues with a visible transcript-delayed status
    And eligible audio is queued for idempotent batch repair

  @MTG-064 @automated @native @recovery
  Scenario: A reconnect replays only bounded recent audio
    Given a live route reconnects after a transient interruption
    When recent audio remains inside the configured replay window
    Then Mimir replays the bounded window once
    And any older unrecoverable interval becomes a transcript gap

  @MTG-065 @manual @native @security
  Scenario: Local transcription makes no external network request
    Given an installed on-device model is selected
    When live or batch transcription runs
    Then audio remains on the device
    And the transcription route opens no non-loopback network connection

  @MTG-066 @manual @native @packaging @release @hardware
  Scenario: In-process local Metal transcription works in a release build
    Given a verified local Whisper model is selected in signed Mimir
    And no sidecar or loopback service is configured
    When packaged Mimir transcribes the release fixture
    Then transcription runs through the product-owned in-process Metal engine
    And model and transcript lifecycle remain owned by Mimir

  @MTG-067 @automated @native @security
  Scenario: A custom hosted URL requires an explicit secure policy
    Given the user configures a custom hosted transcription URL
    When Mimir validates the route before capture
    Then the URL must use HTTPS and satisfy the saved host policy
    And the confirmation identifies the exact destination

  @MTG-068 @automated @native @security
  Scenario: Provider credentials remain native
    Given a transcription provider uses a Keychain credential reference
    When the renderer starts or observes transcription
    Then native transport injects the credential
    And no secret appears in IPC, settings, logs, diagnostics, or meeting metadata

  @MTG-069 @automated @domain @contract
  Scenario: Unsupported language and model combinations fail preflight
    Given a selected route does not support the requested language or mode
    When the user attempts to start transcription
    Then Mimir reports the exact capability mismatch before sending audio
    And recording can proceed only under a deliberately chosen degraded policy

  @MTG-070 @automated @native @recovery
  Scenario: Delayed transcription repair resumes from durable meeting state
    Given transcription repair was running when Mimir exited
    When Mimir relaunches and recovers the meeting
    Then one idempotent repair job is requeued for the terminal transcript revision
    And only integrity-verified committed chunks cross the original consented route and model

  @MTG-071 @automated @domain @contract
  Scenario: Stale transcript writers cannot overwrite a terminal revision
    Given a newer transcript revision is already terminal
    And an older repair attempt later returns output
    When Mimir tries to commit the stale result
    Then the revision conflict fails closed
    And the newer terminal transcript remains authoritative

  @MTG-072 @automated @native @recovery
  Scenario: A failing custom provider has bounded reconnect and delayed repair
    Given a custom hosted route repeatedly returns a retryable transport failure
    When the reconnect budget is exhausted
    Then recent replay remains bounded and one delayed repair is queued
    And recording authority is not blocked by provider retry

  @MTG-073 @automated @native @packaging
  Scenario: A local model download is verified before activation
    Given a supported local model is not installed
    When the user downloads the model
    Then Mimir checks architecture, available disk space, size, and cryptographic digest
    And an incomplete or invalid download cannot become selectable

  @MTG-074 @automated @domain @contract
  Scenario: Transcript segments retain complete provenance
    Given a transcript contains live and batch-derived segments
    When the canonical transcript revision is read
    Then every segment identifies its meeting, run, audio time, channel, revision, source, and finality
    And known gaps remain first-class transcript records
