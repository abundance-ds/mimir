@meetings @finalization @agents
Feature: Finalize a meeting title and summary from a terminal transcript revision
  Title and summary generation is durable follow-up work. It never owns capture
  finalization and never silently replaces a user's authored title or notes.

  @MTG-110 @automated @domain @native
  Scenario: One finalization job follows a terminal transcript revision
    Given recording is finalized and a transcript revision is terminal
    When post-stop finalization is enabled for the meeting
    Then completed lifecycle and its one default summary outbox entry commit in one transaction
    And a failed outbox insert leaves lifecycle finalizing without an orphaned job
    And capture readiness does not depend on the job succeeding

  @MTG-111 @automated @native @contract
  Scenario: A finalization job launches with exact immutable inputs
    Given a queued title and summary job is eligible to run
    When Mimir launches its configured summary format and CLI agent preset
    Then the durable Activity receives exact argv and an immutable transcript snapshot identity
    And the selected system-owned summary format is part of the immutable job input
    And no shell string is parsed or evaluated

  @MTG-112 @automated @domain @native
  Scenario: Generated title and summary remain reviewable
    Given a title and summary job returns valid controlled output
    When Mimir projects the completed meeting
    Then the generated title and summary are visible in Scribe
    And the user can deliberately edit the persisted title or summary

  @MTG-113 @automated @domain @native
  Scenario: Summary output is accepted only for the exact terminal revision
    Given a summary job targets one terminal transcript revision
    When its controlled output is applied
    Then Mimir verifies that exact terminal revision before accepting it
    And a stale or nonterminal revision fails closed

  @MTG-114 @automated @native @recovery
  Scenario: Finalization retries are idempotent
    Given a title and summary job has idempotency identity for one transcript revision
    When the Activity fails, Mimir restarts, or manual retry is requested repeatedly
    Then at most one active attempt owns each retry generation
    And repeated manual retries receive monotonic idempotency generations
    And a completed result is never generated twice

  @MTG-115 @automated @domain @security
  Scenario: Transcript text is untrusted finalization input
    Given the transcript contains text that resembles agent instructions
    When the finalization agent receives the bounded transcript context
    Then system-owned output and tool constraints remain authoritative
    And transcript instructions cannot enable external sending or unrelated mutations

  @MTG-116 @automated @desktop @accessibility
  Scenario: Finalization failure is visible and independently retryable
    Given capture and transcription completed successfully
    When title and summary generation fails
    Then the meeting remains complete with a visible finalization error
    And its durable job state remains independently inspectable and retryable
    And a completed summary can be deliberately created again with the currently selected format and CLI agent

  @MTG-117 @automated @domain @native
  Scenario: A changed transcript creates a new finalization identity
    Given one transcript revision already has a completed finalization job
    When user correction creates a newer terminal transcript revision
    Then Mimir may enqueue a distinct job for the new revision
    And earlier title, summary, and provenance remain recoverable

  @MTG-118 @automated @domain @native
  Scenario: A genuinely silent meeting finalizes without fabricated follow-up
    Given transcription ends with no final speech and no unresolved partial segment
    When the user stops the meeting
    Then Mimir commits an empty terminal transcript and completes the meeting
    And it does not queue title, summary, or graph work for invented content
