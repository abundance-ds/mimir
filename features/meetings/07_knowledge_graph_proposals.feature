@meetings @knowledge-graph @agents
Feature: Propose reviewable knowledge graph updates after a meeting
  Knowledge graph follow-up is prompted, bounded, and reviewable. A generated
  proposal is an artifact for a separate graph workflow and never becomes graph
  truth automatically.

  @MTG-130 @automated @desktop @security
  Scenario: Meeting completion prompts instead of mutating the graph
    Given a meeting has a terminal transcript and finalization result
    When knowledge graph follow-up is available
    Then Mimir offers a clear Create KG draft action
    And no graph node or relationship is changed before the user chooses it

  @MTG-131 @automated @domain @native
  Scenario: A graph proposal uses a controlled transcript snapshot
    Given the user chooses Propose graph update
    When Mimir launches the configured proposal agent
    Then it receives an immutable terminal transcript revision and controlled output path
    And the agent has no direct graph mutation authority

  @MTG-132 @automated @domain @security
  Scenario: Transcript prompt injection cannot bypass proposal review
    Given transcript text requests direct graph mutation or unrelated tool use
    When the graph proposal agent processes the transcript
    Then its output remains a proposal tied to the meeting and source revisions
    And no generated instruction can auto-accept or conceal the proposal

  @MTG-133 @automated @desktop @contract
  Scenario: A valid graph proposal remains a review-only artifact
    Given a proposal job returns a valid proposal for one meeting
    When Mimir validates and projects the output
    Then the exact proposed nodes and relations remain reviewable in Scribe
    And no graph mutation is applied automatically

  @MTG-134 @automated @native @contract
  Scenario: Invalid graph proposal structure fails closed
    Given proposal output contains unknown fields or a dangling relation
    When Mimir validates the controlled output
    Then the proposal job fails without graph mutation
    And malformed output is never projected as reviewable truth

  @MTG-135 @automated @desktop @contract
  Scenario: Declining graph follow-up launches no proposal work
    Given a completed meeting offers graph follow-up
    When the user chooses Not now
    Then no graph proposal job is launched
    And no graph node or relation is changed

  @MTG-136 @automated @native @recovery
  Scenario: Proposal launch is idempotent for a transcript revision
    Given a proposal job already exists for one transcript revision
    When the launch action is repeated or recovered after restart
    Then Mimir reuses the existing job identity
    And it does not create duplicate agent Activities or proposals

  @MTG-137 @automated @native @security
  Scenario: Deleting a meeting cancels queued proposal work
    Given graph proposal work is queued but not running
    When the source meeting is deleted
    Then Mimir cancels the queued work before launch
    And no transcript snapshot remains accessible through that job
