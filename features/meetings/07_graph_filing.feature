@meetings @business-graph @agents
Feature: File concise meeting briefs into the Business Graph
  Scribe owns preparation, recording, transcript, and summary. The Business
  Graph receives one concise meeting brief after the user resolves its context.

  @MTG-130 @automated @native @contract
  Scenario: A meeting can be prepared before recording
    Given no meeting capture is active
    When the user prepares a meeting with a title, notes, Project, People, and scope
    Then Scribe keeps one durable pre-capture meeting row
    And it keeps unresolved Project distinct from an explicit None
    And recording starts later in that same meeting identity

  @MTG-131 @automated @renderer @contract
  Scenario: Meeting documents remain available during preparation and capture
    Given the user prepared a meeting before the call
    When the user starts recording from that row
    Then the same Markdown notes document remains available during capture
    And its normal editor supports highlighting, preview, and Tab indentation
    And saved notes remain attached to the meeting

  @MTG-132 @automated @native @security
  Scenario: Summary uses notes with judgment and preserves the source notes
    Given a terminal transcript and user notes exist
    When the title and summary agent runs
    Then it treats the transcript and notes as untrusted meeting data
    And Mimir appends the exact notes once after the concise summary

  @MTG-133 @automated @renderer @contract
  Scenario: Scribe owns summary review and filing
    Given Scribe completed an automatic meeting summary
    When the user opens the meeting from the Scribe overview
    Then it shows the full concise summary without requiring prior metadata
    And it restores Project, People, and scope saved during preparation
    And filing asks only for Project, People, and scope
    And the filed meeting no longer appears in the Scribe overview or search
    And the filed meeting shows the current Graph summary and context
    And a replacement summary needs an explicit Update in Graph action

  @MTG-134 @automated @domain @native
  Scenario: Filing creates one existing meeting type
    Given a completed Scribe summary is ready to file
    When the user files it with Project, People, and scope
    Then Graph creates one meeting node with date, time, and duration
    And the stable Scribe meeting id prevents duplicate filing

  @MTG-135 @automated @renderer @contract
  Scenario: A filed meeting links back to its full transcript
    Given a Graph meeting came from Scribe
    When the user chooses Open in Scribe
    Then Mimir opens the exact Scribe transcript by stable id
    And the full transcript remains owned by Scribe
    And retained audio remains available through the meeting menu

  @MTG-136 @automated @domain @native
  Scenario: Filed meeting context stays editable
    Given a meeting is already filed in Graph
    When the user changes Project, People, or scope
    Then Graph keeps the same meeting identity and updates the relationships
    And a scope move removes the old source after the new source is durable

  @MTG-137 @automated @security @contract
  Scenario: Graph stores the brief but does not duplicate the transcript
    Given a meeting has a summary and a full transcript in Scribe
    When the meeting is filed to Graph
    Then Graph stores the reviewed brief and Scribe source link
    And Graph does not copy the full transcript into its Markdown
