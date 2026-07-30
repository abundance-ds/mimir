@meetings @recovery
Feature: Recover meeting data and work after interruption
  Recovery favors honest partial results over fabricated completeness and is
  safe to repeat after renderer, process, storage, or power failures.

  @MTG-090 @red @native @recovery
  Scenario: Renderer failure does not terminate native capture
    Given native capture is healthy and the renderer process is lost
    When a renderer later reconnects
    Then native capture has continued under the same run identifier
    And the renderer reconciles from the native snapshot

  @MTG-091 @red @native @recovery
  Scenario: A process crash recovers committed audio chunks
    Given a durable in-progress marker exists for active capture
    When Mimir restarts after the process was terminated
    Then every committed audio chunk is attached to a recoverable meeting
    And any interval after the last durable boundary is reported as uncertain

  @MTG-092 @red @native @recovery
  Scenario: Recovery is idempotent across repeated launches
    Given an interrupted meeting has already entered recovery
    When Mimir is relaunched repeatedly before recovery finishes
    Then one recovery owner continues from the committed checkpoint
    And no audio, transcript segment, or finalization job is duplicated

  @MTG-093 @red @native @security
  Scenario: Corrupt metadata is quarantined without deleting audio
    Given meeting metadata cannot be parsed or migrated
    When native meeting storage loads
    Then the original metadata bytes are preserved for diagnosis
    And discoverable audio remains untouched and unavailable for automatic deletion

  @MTG-094 @red @native @recovery
  Scenario: Recovery blocks retention and finalization jobs
    Given interrupted audio has not yet reached a proven terminal transcript state
    When retention and post-stop workers inspect the meeting
    Then they do not delete audio or enqueue downstream finalization
    And the meeting remains visibly recoverable

  @MTG-095 @red @native @recovery
  Scenario: A stale active record restores as interrupted
    Given persisted metadata says capture was active before the process ended
    When no live device or capture task owns that run after relaunch
    Then the run restores as interrupted rather than active
    And the user is offered recovery or deliberate abandonment

  @MTG-096 @red @native @recovery
  Scenario: Finalization resumes after a crash during container completion
    Given all source chunks are durable but the final audio container is incomplete
    When recovery validates the chunks after relaunch
    Then finalization resumes from those chunks without recapturing audio
    And the source chunks remain until the final container is verified

  @MTG-097 @red @native @contract
  Scenario: Recovery emits diagnosable correlation state without content
    Given a recovery attempt changes state
    When structured diagnostics are recorded
    Then they include meeting, run, attempt, checkpoint, and error identifiers
    And they exclude audio, transcript text, titles, participant data, paths, and credentials
