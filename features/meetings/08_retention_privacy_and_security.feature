@meetings @retention @privacy @security
Feature: Minimize, retain, export, and delete sensitive meeting data deliberately
  Meeting audio and transcripts are sensitive local data. Retention, egress,
  diagnostics, and deletion must be explicit and auditable.

  @MTG-150 @red @domain @native
  Scenario: A meeting records the effective retention policy
    Given the user chooses no audio retention, a finite duration, or forever
    When a new capture becomes active
    Then the meeting records the effective policy and policy version
    And later settings changes do not retroactively change it without confirmation

  @MTG-151 @red @native @recovery
  Scenario: Recovery-required audio cannot expire
    Given audio is required to recover a missing or failed transcript
    When its ordinary retention deadline passes
    Then Mimir retains the required audio with a visible hold reason
    And removal becomes eligible only after recovery is resolved or abandoned

  @MTG-152 @red @native @security
  Scenario: Retention deletes only verified eligible audio
    Given a meeting has a durable terminal transcript and no dependent job needs audio
    When the retention deadline passes
    Then Mimir removes only the audio artifacts owned by that meeting
    And notes, transcript, provenance, and deletion outcome remain consistent with policy

  @MTG-153 @red @native @security
  Scenario: Delete meeting cancels owned background work
    Given a meeting has queued transcription, finalization, or proposal jobs
    When the user confirms Delete meeting
    Then Mimir cancels or terminally detaches all owned jobs before data removal
    And a late job result cannot recreate deleted meeting content

  @MTG-154 @red @domain @contract
  Scenario: Export identifies provenance and known gaps
    Given a meeting has multiple takes, corrected text, and a known transcript gap
    When the user exports the meeting
    Then the export identifies takes, time coordinates, speakers or channels, source routes, revisions, and gaps
    And it does not represent inferred or missing speech as verbatim fact

  @MTG-155 @red @native @security
  Scenario: Local meeting storage uses owner-only access
    Given Mimir creates meeting metadata, transcript, audio, or job files
    When the artifact is committed on a supported platform
    Then its directory and file permissions follow the owner-only storage policy
    And secret material is never stored beside meeting content

  @MTG-156 @red @native @security
  Scenario: Meeting paths cannot escape their storage root
    Given a meeting identifier, imported name, or manifest contains traversal or a symlink escape
    When Mimir resolves an owned meeting artifact
    Then native validation rejects the escaped path
    And no external file is read, overwritten, exported, or deleted

  @MTG-157 @red @native @security
  Scenario: Diagnostics contain operation metadata but no meeting content
    Given capture, transcription, recovery, or a hook fails
    When structured logs and a diagnostic bundle are produced
    Then they include bounded error, timing, route, queue, and correlation metadata
    And they exclude audio, transcript text, titles, participants, filesystem paths, credentials, and provider payloads

  @MTG-158 @red @native @security
  Scenario: Local mode has a network-deny acceptance check
    Given local transcription and local finalization are selected
    When a complete meeting is captured, transcribed, titled, and summarized
    Then no non-loopback connection is attempted by the meeting subsystem
    And any unexpected egress fails the release evidence check

  @MTG-159 @red @domain @security
  Scenario: Meeting tools remain private by default
    Given the local MCP endpoint can be reached by trusted local processes
    When meeting capabilities are registered
    Then recording, deletion, retention, and raw transcript operations are absent from the public projection
    And explicit future exposure requires a separate threat-model and schema review

  @MTG-160 @red @desktop @legal
  Scenario: Deletion explains recoverability boundaries
    Given the user requests permanent meeting deletion
    When Mimir presents the confirmation
    Then it identifies which local artifacts and jobs will be removed
    And it does not promise erasure from filesystem snapshots, backups, synced copies, or prior provider processing
