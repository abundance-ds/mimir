@meetings @knowledge-graph @agents
Feature: Propose reviewable knowledge graph updates after a meeting
  Knowledge graph follow-up is prompted, bounded, and reviewable. A generated
  proposal does not become graph truth until the user accepts it.

  @MTG-130 @red @desktop @security
  Scenario: Meeting completion prompts instead of mutating the graph
    Given a meeting has a terminal transcript and finalization result
    When knowledge graph follow-up is available
    Then Mimir offers a clear Propose graph update action
    And no graph node or relationship is changed before the user chooses it

  @MTG-131 @red @domain @native
  Scenario: A graph proposal uses bounded scoped context
    Given the user chooses Propose graph update
    And the user selects the intended graph scopes or focus node
    When Mimir launches the configured proposal agent
    Then it receives the immutable transcript revision and bounded selected graph context
    And private or unselected graph scopes are excluded

  @MTG-132 @red @domain @security
  Scenario: Transcript prompt injection cannot bypass proposal review
    Given transcript text requests direct graph mutation or unrelated tool use
    When the graph proposal agent processes the transcript
    Then its output remains a proposal tied to the meeting and source revisions
    And no generated instruction can auto-accept or conceal the proposal

  @MTG-133 @red @desktop @contract
  Scenario: Accepting a valid proposal applies revision-aware changes
    Given a graph proposal is open for review
    And its source node revisions still match
    When the user accepts the proposal
    Then the exact reviewed changes are applied through graph authority
    And meeting, Activity, proposal, and resulting graph events retain provenance

  @MTG-134 @red @desktop @contract
  Scenario: A graph revision conflict remains reviewable
    Given a graph proposal references a node changed after proposal creation
    When the user attempts to accept it
    Then Mimir reports the revision conflict without overwriting the node
    And the proposal remains open for refresh, edit, or rejection

  @MTG-135 @red @desktop @contract
  Scenario: Rejecting a proposal has no graph side effect
    Given a graph proposal is open for review
    When the user rejects it
    Then no proposed graph mutation is applied
    And the rejected outcome remains associated with its Activity and meeting

  @MTG-136 @red @native @recovery
  Scenario: Proposal launch is idempotent for a transcript and scope selection
    Given a proposal job already exists for one transcript revision and scope set
    When the launch action is repeated or recovered after restart
    Then Mimir reuses the existing job identity
    And it does not create duplicate agent Activities or proposals

  @MTG-137 @red @native @security
  Scenario: Deleting a meeting cancels queued proposal work
    Given graph proposal work is queued but not running
    When the source meeting is deleted
    Then Mimir cancels the queued work before launch
    And no transcript snapshot remains accessible through that job
