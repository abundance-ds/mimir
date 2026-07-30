@meetings @detection @consent
Feature: Detect meetings without recording before the user has authority
  Mimir may notice that a meeting is likely, but detection and recording are
  separate states. The user must always be able to tell what is happening and
  what data, if any, will leave the device.

  @MTG-001 @automated @native @security
  Scenario: Sustained meeting application use creates one local suggestion
    Given meeting detection is enabled with a sustained-use threshold
    And a supported meeting application begins using the microphone
    When the threshold elapses while the application remains active
    Then Mimir presents exactly one local meeting suggestion
    And no audio file, transcript request, or finalization job is created

  @MTG-002 @automated @native @security
  Scenario: Repeated detection signals are coalesced
    Given a meeting suggestion is already open for an active application
    When equivalent microphone and application signals arrive again
    Then Mimir keeps the existing suggestion
    And no duplicate suggestion or capture session is created

  @MTG-003 @automated @native @security
  Scenario: Detection degrades clearly without microphone authority
    Given application-aware detection does not have microphone observation authority
    When native detection reports the denied permission
    Then Mimir exposes one actionable permission state
    And Mimir creates no candidate and does not repeatedly request permission

  @MTG-004 @automated @native @security
  Scenario: Ignored applications and disabled detection are respected
    Given an application is on the meeting-detection ignore list
    And meeting detection can be disabled in native configuration
    When the ignored application uses the microphone or detection is disabled
    Then Mimir does not present a meeting suggestion
    And detection does not start capture

  @MTG-005 @automated @desktop @legal
  Scenario: A detected meeting requires deliberate recording consent
    Given Mimir has suggested a detected meeting
    When the user dismisses the suggestion without choosing Record
    Then no capture session is armed
    And the dismissal does not count as recording consent

  @MTG-006 @automated @desktop @legal @security
  Scenario: Hosted processing is disclosed before recording starts
    Given a hosted transcription route is selected
    When the user opens the recording confirmation
    Then Mimir identifies the hosted destination and the data it will receive
    And capture cannot start until the user deliberately confirms the route

  @MTG-007 @automated @desktop @legal
  Scenario: Detection never grants automatic recording authority
    Given meeting detection is enabled
    When a detector suggestion is accepted or dismissed
    Then only an explicit human Record action can start capture
    And no calendar or detector event is treated as recording consent

  @MTG-008 @automated @desktop @accessibility @legal
  Scenario: A persistent recording indicator follows native capture state
    Given native capture has become active
    When the user navigates away from the meeting surface
    Then the workbench sidebar and global tool chrome identify the active recording
    And a one-step Stop control remains available until native capture is inactive
