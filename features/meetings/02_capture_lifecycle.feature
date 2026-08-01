@meetings @lifecycle
Feature: Own meeting capture as one durable native lifecycle
  Native capture is authoritative across renderer reloads, concurrent commands,
  workbench navigation, and application shutdown.

  @MTG-020 @automated @domain @native
  Scenario: A capture follows the complete state machine
    Given no meeting capture is active
    When a valid capture request succeeds
    Then the session progresses through detected, recording, stopping, and finalizing
    And it reaches completed only after durable finalization completes

  @MTG-021 @automated @domain @native
  Scenario: A second capture cannot race the active capture
    Given one meeting capture is active
    When another start request arrives for a different meeting
    Then the request fails with the active meeting identity
    And no second audio device or writer is opened

  @MTG-022 @automated @domain @native
  Scenario: Duplicate and stale capture controls fail safely
    Given one capture request has a stable request identifier
    When a duplicate start or a stale stop request is delivered
    Then the active run identity remains authoritative
    And no duplicate lifecycle transition is committed

  @MTG-023 @automated @native @contract
  Scenario: Renderer reload reconciles instead of duplicating capture
    Given native capture remains active while the renderer reloads
    When the new renderer installs listeners and reads the native snapshot
    Then it projects the existing session and run identifier
    And it does not start, stop, or replace native capture

  @MTG-024 @automated @domain @native
  Scenario: Late events from an old run cannot mutate a resumed meeting
    Given a meeting contains an ended capture run and a newer active run
    When an event from the ended run arrives late
    Then the newer run remains unchanged
    And the late event is ignored with its correlation identifiers

  @MTG-025 @automated @native @desktop
  Scenario: Quit while recording requires an explicit outcome
    Given a capture is active when application Quit is requested, even if the renderer window was destroyed
    When Mimir begins its guarded shutdown
    Then an available renderer lets the user return to recording or stop and finalize
    And without a renderer native Stop completes before exit or Mimir stays open

  @MTG-026 @automated @domain @native
  Scenario: A terminal meeting never reopens
    Given a meeting already has a terminal capture and transcript
    When another recording is requested
    Then Mimir creates a distinct meeting and run identifier
    And the terminal meeting and its transcript provenance remain immutable

  @MTG-027 @automated @native @contract
  Scenario: Events notify while snapshots recover state
    Given a capture transition is committed before a renderer listener exists
    When the renderer later installs the listener and drains the native snapshot
    Then it observes the committed transition exactly once
    And correctness does not depend on replaying a lost event payload

  @MTG-028 @automated @native @recovery
  Scenario: Stop racing an ended capture worker keeps one recovery owner
    Given the native capture worker has ended and its failure callback is waiting behind Stop
    When Stop receives the ended-worker error first
    Then the meeting becomes durably interrupted and releases active ownership
    And Stop drains and removes the live transcriber before same-process repair can be claimed
    And exactly one repair job remains bound to the original capture generation
    And the delayed failure callback cannot duplicate or replace that recovery owner

  @MTG-029 @automated @native @recovery
  Scenario: Stop accepts a reconnect gap committed while capture is joining
    Given native capture is reconnecting an audio device when Stop begins
    When capture records the unavailable interval before its worker joins
    Then Stop refreshes the durable meeting revision after capture teardown
    And the meeting reaches durable finalization with the reconnect gap preserved

  @MTG-030 @automated @native @performance @recovery
  Scenario: A slow native device open never traps recording controls
    Given a requested audio device is blocked inside native initialization
    When the user starts a meeting
    Then durable capture ownership is returned promptly without waiting for device readiness
    And Stop can cancel the owned startup without reporting a missing audio worker
    And snapshots remain available while native cleanup finishes in the background
