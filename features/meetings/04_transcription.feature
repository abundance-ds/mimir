@meetings @transcription
Feature: Produce live and batch transcripts through local or custom routes
  Transcription is revisioned, bounded, recoverable, and subordinate to the
  authoritative recording.

  @MTG-060 @red @domain @contract
  Scenario: Provisional words can be revised before they become final
    Given a live provider has emitted a provisional segment
    When the provider emits a later revision for the same segment identity
    Then Mimir replaces only the provisional projection
    And the final segment retains stable audio-time provenance

  @MTG-061 @red @domain @contract
  Scenario: Duplicate and out-of-order provider messages are idempotent
    Given transcript deltas carry provider sequence and segment identities
    When duplicate and out-of-order deltas arrive
    Then the canonical transcript contains each accepted revision once
    And stale deltas cannot rewrite a newer final revision

  @MTG-062 @red @native @performance
  Scenario: Live transcript deltas are batched for the renderer
    Given a provider emits partial tokens faster than the projection budget
    When native transcription accepts those deltas
    Then Mimir coalesces renderer notifications within the manifest rate budget
    And the durable final transcript preserves the complete accepted text

  @MTG-063 @red @native @recovery
  Scenario: Live transcription failure degrades to delayed transcription
    Given recording and live transcription are active
    When the live route fails but recording remains healthy
    Then recording continues with a visible transcript-delayed status
    And eligible audio is queued for idempotent batch repair

  @MTG-064 @red @native @recovery
  Scenario: A reconnect replays only bounded recent audio
    Given a live route reconnects after a transient interruption
    When recent audio remains inside the configured replay window
    Then Mimir replays the bounded window once
    And any older unrecoverable interval becomes a transcript gap

  @MTG-065 @red @native @security
  Scenario: Local transcription makes no external network request
    Given an installed on-device model is selected
    When live or batch transcription runs
    Then audio remains on the device
    And the transcription route opens no non-loopback network connection

  @MTG-066 @red @native @packaging
  Scenario: Local loopback transcription works in a release build
    Given a signed local transcription sidecar is selected
    And its loopback endpoint matches the product-owned local policy
    When packaged Mimir starts transcription
    Then the route is accepted without enabling arbitrary localhost providers
    And the sidecar lifecycle is owned and stopped by Mimir

  @MTG-067 @red @native @security
  Scenario: A custom hosted URL requires an explicit secure policy
    Given the user configures a custom hosted transcription URL
    When Mimir validates the route before capture
    Then the URL must use HTTPS and satisfy the saved host policy
    And the confirmation identifies the exact destination

  @MTG-068 @red @native @security
  Scenario: Provider credentials remain native
    Given a transcription provider uses a Keychain credential reference
    When the renderer starts or observes transcription
    Then native transport injects the credential
    And no secret appears in IPC, settings, logs, diagnostics, or meeting metadata

  @MTG-069 @red @domain @contract
  Scenario: Unsupported language and model combinations fail preflight
    Given a selected route does not support the requested language or mode
    When the user attempts to start transcription
    Then Mimir reports the exact capability mismatch before sending audio
    And recording can proceed only under a deliberately chosen degraded policy

  @MTG-070 @red @native @recovery
  Scenario: Batch transcription resumes committed chunks after relaunch
    Given batch transcription committed some audio chunks before Mimir exited
    When Mimir relaunches and resumes the batch job
    Then only unfinished chunks are submitted
    And completed chunks are not duplicated or billed again

  @MTG-071 @red @domain @contract
  Scenario: Batch output repairs gaps without overwriting user corrections
    Given a user has corrected final transcript text
    And batch transcription later returns text for a live gap
    When Mimir promotes the batch result
    Then it fills only eligible source gaps
    And the user-authored correction remains authoritative

  @MTG-072 @red @native @recovery
  Scenario: A rate-limited custom provider remains retryable
    Given a custom hosted batch route returns a bounded rate-limit response
    When the retry policy schedules another attempt
    Then the job retains its audio chunk and idempotency identity
    And the user can inspect, retry, change route, or cancel it

  @MTG-073 @red @native @packaging
  Scenario: A local model download is verified before activation
    Given a supported local model is not installed
    When the user downloads the model
    Then Mimir checks architecture, available disk space, size, and cryptographic digest
    And an incomplete or invalid download cannot become selectable

  @MTG-074 @red @domain @contract
  Scenario: Transcript segments retain complete provenance
    Given a transcript contains live and batch-derived segments
    When the canonical transcript revision is read
    Then every segment identifies its take, audio time, channel or speaker, language, route, provider, model, and finality
    And known gaps remain first-class transcript records
