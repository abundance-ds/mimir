@meetings @recovery
Feature: Recover meeting data and work after interruption
  Recovery favors honest partial results over fabricated completeness and is
  safe to repeat after renderer, process, storage, or power failures.

  @MTG-090 @automated @native @recovery
  Scenario: Renderer failure does not terminate native capture
    Given native capture is healthy and the renderer process is lost
    When a renderer later reconnects
    Then native capture has continued under the same run identifier
    And the renderer reconciles from the native snapshot

  @MTG-091 @automated @native @recovery
  Scenario: A process crash recovers committed audio chunks
    Given a durable in-progress marker exists for active capture
    When Mimir restarts after the process was terminated
    Then every committed audio chunk is attached to a recoverable meeting
    And any interval after the last durable boundary is reported as uncertain

  @MTG-092 @automated @native @recovery
  Scenario: Recovery is idempotent across repeated launches
    Given an interrupted meeting has already entered recovery
    When Mimir is relaunched repeatedly before recovery finishes
    Then one capture-generation recovery owner restarts from verified committed audio
    And incomplete repair output remains private until one terminal revision atomically replaces stale STT rows
    And capture gaps and transcript history remain intact without duplicate jobs or segments

  @MTG-093 @automated @native @security
  Scenario: Corrupt sidecar configuration is quarantined without touching meetings
    Given native Scribe configuration cannot be parsed or validated
    When the meeting platform loads
    Then the original configuration bytes are quarantined for diagnosis
    And authoritative meeting database and audio artifacts remain untouched

  @MTG-094 @automated @native @recovery
  Scenario: Recovery respects terminal boundaries for downstream jobs
    Given interrupted audio has not yet reached a proven terminal transcript state
    When startup recovery inspects the meeting
    Then it marks stale capture interrupted and requeues eligible transcription repair
    And summary or graph work is not launched without a terminal transcript

  @MTG-095 @automated @native @recovery
  Scenario: A stale active record restores as interrupted
    Given persisted metadata says capture was active before the process ended
    When no live device or capture task owns that run after relaunch
    Then the run restores as interrupted rather than active
    And the user is offered recovery or deliberate abandonment

  @MTG-096 @automated @native @recovery
  Scenario: Recovery preserves verified staged audio chunks
    Given source chunks were durably staged before process interruption
    When recovery validates the chunks after relaunch
    Then the recoverable meeting references those chunks without recapturing audio
    And missing or invalid chunk boundaries are reported rather than fabricated

  @MTG-097 @automated @native @contract
  Scenario: Recovery emits diagnosable correlation state without content
    Given a recovery attempt changes state
    When structured diagnostics are recorded
    Then they include bounded operation, route, attempt, state, and error identifiers
    And they exclude audio, transcript text, titles, participant data, paths, and credentials

  @MTG-098 @automated @native @security @recovery
  Scenario: A durable terminal transcript is never disclosed again after a lifecycle crash
    Given an all-final terminal transcript reached durable storage before lifecycle completion
    When startup recovery or completed-job redelivery inspects the meeting
    Then the lifecycle completes locally and downstream work remains idempotent
    And no model, credential, provider connection, or audio disclosure starts

  @MTG-099 @automated @native @performance @recovery
  Scenario: Large repair reconciliation commits as one bounded authority change
    Given a private repair generation contains more than one hundred thousand final segments
    When its terminal marker is committed
    Then set-based reconciliation creates exactly one transcript revision
    And no staged partial is searchable or visible before that atomic commit
