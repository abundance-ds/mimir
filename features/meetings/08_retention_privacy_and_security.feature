@meetings @retention @privacy @security
Feature: Minimize, retain, export, and delete sensitive meeting data deliberately
  Meeting audio and transcripts are sensitive local data. Retention, egress,
  diagnostics, and deletion must be explicit and auditable.

  @MTG-150 @automated @domain @native
  Scenario: Native configuration owns a finite audio retention policy
    Given the user chooses a supported finite audio retention duration
    When native meeting configuration is committed
    Then retention uses that validated duration for terminal meetings
    And active meetings remain outside expiry eligibility

  @MTG-151 @automated @native @recovery
  Scenario: Active lifecycle audio cannot expire
    Given a meeting is detected, recording, stopping, or finalizing
    When the retention worker inspects an expired timestamp
    Then Mimir skips that meeting
    And no active audio chunk or metadata is tombstoned

  @MTG-152 @automated @native @security
  Scenario: Retention deletes only verified eligible audio
    Given a meeting has a durable terminal transcript and no dependent job needs audio
    When the retention deadline passes
    Then Mimir removes only the audio artifacts owned by that meeting
    And notes, transcript, provenance, and deletion outcome remain consistent with policy

  @MTG-153 @automated @native @security
  Scenario: Delete meeting safely drains owned background work
    Given a meeting has queued or running transcription, finalization, or proposal jobs
    When the user confirms Delete meeting
    Then Mimir cancels unclaimed jobs and tombstones the record before another claim
    And the meeting disappears without waiting for transcription or an owned Activity
    And physical cleanup waits while a native transcriber owns files or an Activity holds a running lease
    And late note saves and snapshots cannot restore the deleted meeting
    And the late result only releases that wait and cannot recreate deleted content
    And managed hook transcript inputs are removed with the owned meeting directory

  @MTG-154 @automated @domain @contract
  Scenario: Export identifies provenance and known gaps
    Given a meeting has revisioned text, channel attribution, and a known transcript gap
    When the user exports the meeting
    Then the export identifies time coordinates, channels, transcript revisions, and gaps
    And it does not represent inferred or missing speech as verbatim fact
    And Show files writes the current Markdown into the owned meeting directory beside available source audio

  @MTG-155 @automated @native @security
  Scenario: Local meeting storage uses owner-only access
    Given Mimir creates meeting metadata, transcript, audio, or job files
    When the artifact is committed on a supported platform
    Then its directory and file permissions follow the owner-only storage policy
    And secret material is never stored beside meeting content

  @MTG-156 @automated @native @security
  Scenario: Meeting paths cannot escape their storage root
    Given a meeting identifier, imported name, or manifest contains traversal or a symlink escape
    When Mimir resolves an owned meeting artifact
    Then native validation rejects the escaped path
    And no external file is read, overwritten, exported, or deleted

  @MTG-157 @automated @native @security
  Scenario: Diagnostics contain operation metadata but no meeting content
    Given capture, transcription, recovery, or a hook fails
    When structured logs and a diagnostic bundle are produced
    Then they include bounded error, timing, route, queue, and correlation metadata
    And they exclude audio, transcript text, titles, participants, filesystem paths, credentials, and provider payloads

  @MTG-158 @manual @native @security @release
  Scenario: Local mode has a network-deny acceptance check
    Given local transcription and a local CLI finalization preset are selected
    When the packaged release captures, transcribes, titles, and summarizes a synthetic meeting
    Then no non-loopback connection is attempted by the meeting subsystem
    And any unexpected egress fails the release evidence check

  @MTG-159 @automated @domain @security
  Scenario: Meeting tools remain private by default
    Given the local MCP endpoint can be reached by trusted local processes
    When meeting capabilities are registered
    Then recording, stop, and retention operations are absent from the public projection
    And bounded list, get, search, metadata update, and explicit deletion operations remain available
    And a live meeting update is rejected before the content projection can be written

  @MTG-160 @automated @desktop @legal
  Scenario: Deletion explains recoverability boundaries
    Given the user requests permanent meeting deletion
    When Mimir presents the confirmation
    Then it identifies the native delete mode as permanent and irreversible
    And native deletion applies only after explicit confirmation

  @MTG-161 @automated @native @security @recovery
  Scenario: Unresolved transcript repair retains its source audio
    Given transcript repair is collecting or a retry no longer has committed source audio
    When explicit deletion, retention, or repair retry evaluates that meeting
    Then collecting repair blocks source-audio removal even after job attempts are exhausted
    And a retry with no committed source audio fails before any provider is started

  @MTG-162 @automated @native @security @contract
  Scenario: An agent deletes only the explicitly identified meeting data
    Given the user explicitly requests deletion of a stopped meeting
    And the agent has read its current meeting identifier and reviewed title
    When the agent calls meeting deletion with that identifier, exact title, and an explicit audio or meeting scope
    Then Mimir uses the native deletion state machine rather than filesystem removal
    And a stale title, unknown scope, live meeting, or deletion blocked by owned work fails without deleting data
