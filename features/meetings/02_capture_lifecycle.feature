@meetings @lifecycle
Feature: Own meeting capture as one durable native lifecycle
  Native capture is authoritative across renderer reloads, concurrent commands,
  workbench navigation, and application shutdown.

  @MTG-020 @red @domain @native
  Scenario: A capture follows the complete state machine
    Given no meeting capture is active
    When a valid capture request succeeds
    Then the session progresses through arming, capturing, stopping, and finalizing
    And it reaches ready only after durable finalization completes

  @MTG-021 @red @domain @native
  Scenario: A second capture cannot race the active capture
    Given one meeting capture is active
    When another start request arrives for a different meeting
    Then the request fails with the active meeting identity
    And no second audio device or writer is opened

  @MTG-022 @red @domain @native
  Scenario: Start and stop requests are idempotent
    Given one capture request has a stable request identifier
    When the start or stop request is delivered more than once
    Then each duplicate returns the first terminal result
    And only one lifecycle transition is committed

  @MTG-023 @red @native @contract
  Scenario: Renderer reload reconciles instead of duplicating capture
    Given native capture remains active while the renderer reloads
    When the new renderer installs listeners and reads the native snapshot
    Then it projects the existing session and run identifier
    And it does not start, stop, or replace native capture

  @MTG-024 @red @domain @native
  Scenario: Late events from an old run cannot mutate a resumed meeting
    Given a meeting contains an ended capture run and a newer active run
    When an event from the ended run arrives late
    Then the newer run remains unchanged
    And the late event is ignored with its correlation identifiers

  @MTG-025 @red @native @desktop
  Scenario: Quit while recording requires an explicit outcome
    Given a capture is active when application Quit is requested
    When Mimir begins its guarded shutdown
    Then the user can return to recording or stop and finalize before quitting
    And native exit is not confirmed while capture ownership is unresolved

  @MTG-026 @red @domain @native
  Scenario: A finished meeting can receive another immutable take
    Given a meeting already has one finalized capture take
    When the user resumes recording into that meeting
    Then Mimir creates a new take with a new run identifier
    And the earlier take and its transcript provenance remain immutable

  @MTG-027 @red @native @contract
  Scenario: Events notify while snapshots recover state
    Given a capture transition is committed before a renderer listener exists
    When the renderer later installs the listener and drains the native snapshot
    Then it observes the committed transition exactly once
    And correctness does not depend on replaying a lost event payload
