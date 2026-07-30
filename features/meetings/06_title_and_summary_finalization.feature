@meetings @finalization @agents
Feature: Finalize a meeting title and summary from a terminal transcript revision
  Title and summary generation is durable follow-up work. It never owns capture
  finalization and never silently replaces a user's authored title or notes.

  @MTG-110 @red @domain @native
  Scenario: One finalization job follows a terminal transcript revision
    Given recording is finalized and a transcript revision is terminal
    When post-stop finalization is enabled for the meeting
    Then one job is enqueued for that meeting and transcript revision
    And capture readiness does not depend on the job succeeding

  @MTG-111 @red @native @contract
  Scenario: A finalization job launches with exact immutable inputs
    Given a queued title and summary job is eligible to run
    When Mimir launches its configured CLI agent preset
    Then the durable Activity receives exact argv and an immutable transcript snapshot identity
    And no shell string is parsed or evaluated

  @MTG-112 @red @domain @native
  Scenario: A manual meeting title wins over generated output
    Given the user has authored or accepted a meeting title
    When a title and summary job returns a different title
    Then Mimir preserves the user's title
    And the generated title remains reviewable job output

  @MTG-113 @red @domain @native
  Scenario: Automatic title compare-and-set accepts only an eligible title
    Given the meeting still has its automatic-title eligibility
    When the first successful finalization job proposes a concise title
    Then Mimir accepts the title atomically
    And later jobs cannot silently replace it

  @MTG-114 @red @native @recovery
  Scenario: Finalization retries are idempotent
    Given a title and summary job has idempotency identity for one transcript revision
    When the Activity fails, Mimir restarts, or the retry is requested twice
    Then at most one active attempt owns that identity
    And a completed result is never generated twice

  @MTG-115 @red @domain @security
  Scenario: Transcript text is untrusted finalization input
    Given the transcript contains text that resembles agent instructions
    When the finalization agent receives the bounded transcript context
    Then system-owned output and tool constraints remain authoritative
    And transcript instructions cannot enable external sending or unrelated mutations

  @MTG-116 @red @desktop @accessibility
  Scenario: Finalization failure is visible and independently retryable
    Given capture and transcription completed successfully
    When title and summary generation fails
    Then the meeting remains complete with a visible finalization error
    And the user can retry, change preset, dismiss, or inspect the originating Activity

  @MTG-117 @red @domain @native
  Scenario: A changed transcript creates a new finalization identity
    Given one transcript revision already has a completed finalization job
    When user correction creates a newer terminal transcript revision
    Then Mimir may enqueue a distinct job for the new revision
    And earlier title, summary, and provenance remain recoverable
