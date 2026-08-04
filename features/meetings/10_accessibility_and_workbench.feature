@meetings @accessibility @workbench
Feature: Keep recording state operable and understandable throughout Mimir
  Meeting controls follow Mimir's pane, focus, theme, zoom, and accessibility
  contracts rather than importing another application's interaction model.

  @MTG-200 @manual @renderer @accessibility
  Scenario: Every recording action is keyboard operable
    Given focus is within the meeting surface
    When the user navigates without a pointer
    Then start, confirm, stop, retry, export, and review actions are reachable and named
    And visible focus remains on the control or resulting surface

  @MTG-201 @manual @renderer @accessibility
  Scenario: Async meeting state is announced without flooding
    Given assistive technology is observing meeting status
    When capture, transcription, finalization, or recovery changes state
    Then meaningful state changes are announced through bounded status regions
    And partial transcript tokens and level-meter updates are not individually announced

  @MTG-202 @manual @renderer @accessibility
  Scenario: Recording and degraded states never depend on color alone
    Given any supported Mimir theme is active
    When recording is active or a channel is degraded
    Then text or an accessible glyph identifies the state
    And contrast and focus relationships use the design-system tokens

  @MTG-203 @automated @desktop @accessibility
  Scenario: Pane collapse cannot hide the recording controls
    Given capture is active in a meeting Activity or Tool
    When the Activity or Editor pane is collapsed or the meeting surface is hidden
    Then another mounted visible surface retains named microphone mute and Stop controls
    And focus is transferred away from hidden content

  @MTG-204 @manual @desktop @accessibility @release
  Scenario: Meeting controls survive the release visual matrix
    Given narrow, default, and wide workbench layouts
    When each theme, reduced motion, and 100, 125, and 150 percent zoom is exercised
    Then recording identity, provider route, progress, errors, and controls remain legible and stable
    And no required action exists only in a tooltip or hover state

  @MTG-205 @automated @desktop @accessibility
  Scenario: Permission denial provides an accessible recovery path
    Given microphone or system-audio permission is denied
    When the user inspects the failed capture attempt
    Then Mimir identifies the denied capability in text
    And exposes a keyboard-operable system-settings and retry path

  @MTG-206 @automated @renderer @accessibility
  Scenario: Overlapping settings changes are never silently dropped
    Given one native Scribe configuration mutation is still pending
    When the user attempts another configuration change
    Then every configuration control exposes the pending state
    And accepted mutations commit in request order without returning an empty success

  @MTG-207 @automated @renderer @contract
  Scenario: Reviewed tags remain visible and editable
    Given a terminal meeting has reviewed tags
    When the meeting appears in native detail, agent metadata, and the Scribe review surface
    Then the same bounded tags are visible instead of becoming write-only metadata
    And the user can keyboard-edit at most 64 tags of at most 80 characters each

  @MTG-208 @automated @renderer @accessibility
  Scenario: Review opens on the useful result without duplicating global settings
    Given a completed meeting already has a summary
    When the user opens that meeting
    Then Summary is the default tab and its task controls precede the summary
    And the detail header contains only Back and one actions menu
    And the global summary prompt remains editable in exactly one settings surface

  @MTG-209 @automated @renderer @contract
  Scenario: A growing meeting library stays findable
    Given the recent snapshot is bounded and older meetings remain durable
    When the user searches at least three characters
    Then native search covers titles, summaries, tags, and transcript text across the full library
    And ordinary browsing shows today's meetings before older unresolved meetings, Previous 7 days, and Earlier

  @MTG-210 @automated @renderer @accessibility
  Scenario: Meeting actions are consistent from list and detail
    Given a meeting is visible in the library or detail view
    When the user opens its context or overflow menu with pointer or keyboard
    Then Rename, Show in Finder, save-copy actions, and Delete are available in one menu
    And destructive deletion still requires explicit confirmation

  @MTG-211 @automated @renderer @recovery
  Scenario: A failed transcript has an immediate repair action
    Given retained source audio exists for a meeting whose transcript needs attention
    When the meeting detail is opened
    Then Transcribe again is visible beside the failure state and in the actions menu
    And it reprocesses with the currently selected provider and model

  @MTG-212 @automated @renderer @accessibility
  Scenario: Errors never obstruct recording control
    Given recording continues while transcription reports a recoverable error
    When the error is visible
    Then Stop remains fixed, visible, and keyboard operable above the diagnostic

  @MTG-213 @automated @renderer @recovery
  Scenario: Transcript repair exposes durable progress
    Given retained audio is safe and retranscription has been queued
    When the meeting detail is open
    Then the repair notice says Queued or Transcribing until the job finishes
    And Transcribe again cannot enqueue a duplicate job while repair is active
