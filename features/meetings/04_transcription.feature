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
    Then one idempotent repair job is requeued for the immutable capture generation
    And repair restarts from integrity-verified committed audio under the original consented route and model

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

  @MTG-075 @automated @native @recovery @performance
  Scenario: Cold local model startup remains owned without delaying recording
    Given a verified local model needs longer than the former startup deadline to initialize
    When the user starts and later stops recording
    Then recording starts promptly with transcription shown as initializing
    And the owned worker either finalizes normally or queues one durable delayed repair without exposing worker internals

  @MTG-076 @automated @native @contract @performance
  Scenario: OpenAI transcribes both capture channels continuously
    Given the hosted route uses the OpenAI Realtime transcription contract
    When committed microphone and system chunks arrive during recording
    Then Mimir streams each channel through an independently owned session
    And transcript deltas retain Mimir's You and Others channel provenance

  @MTG-077 @automated @native @security
  Scenario: OpenAI credentials remain endpoint-bound in Keychain
    Given the OpenAI Realtime endpoint is selected
    When the credential is saved and the native WebSocket handshake is created
    Then native storage confirms an endpoint-bound Keychain read-back before reporting success
    Then the API key is injected only as an Authorization bearer header
    And the key never appears in renderer state, meeting provenance, diagnostics, or URLs

  @MTG-078 @automated @frontend @contract
  Scenario: Selecting hosted transcription cannot fail on an empty hidden field
    Given local transcription is selected and no hosted fields were configured
    When the user selects OpenAI transcription
    Then one ordered settings mutation supplies the OpenAI URL and model with the route
    And the API-key field becomes the only required next action
    And confirmed credentials can be visibly replaced or removed

  @MTG-079 @automated @frontend @contract
  Scenario: Review retains the transcript that was visible during recording
    Given the library snapshot omits transcript text for fast startup
    And the selected meeting transcript page contains durable final segments
    When the user stops or reopens that meeting in Review
    Then Review renders the paged transcript rather than the empty library projection
    And final transcript text does not disappear during the recording-to-review handoff

  @MTG-080 @automated @frontend @contract
  Scenario: Visible live words supersede a lagging readiness label
    Given durable transcript segments are arriving during capture
    And the worker readiness projection still says initializing
    When Scribe renders the live transcript ledger
    Then the status says transcription is live
    And it does not tell the user transcription is still being prepared
