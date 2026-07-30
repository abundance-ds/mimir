@meetings @detection @consent
Feature: Detect meetings without recording before the user has authority
  Mimir may notice that a meeting is likely, but detection and recording are
  separate states. The user must always be able to tell what is happening and
  what data, if any, will leave the device.

  @MTG-001 @red @native @security
  Scenario: Sustained meeting application use creates one local suggestion
    Given meeting detection is enabled with a sustained-use threshold
    And a supported meeting application begins using the microphone
    When the threshold elapses while the application remains active
    Then Mimir presents exactly one local meeting suggestion
    And no audio file, transcript request, or finalization job is created

  @MTG-002 @red @native @security
  Scenario: Repeated detection signals are coalesced
    Given a meeting suggestion is already open for an active application
    When equivalent microphone and application signals arrive again
    Then Mimir keeps the existing suggestion
    And no duplicate suggestion or capture session is created

  @MTG-003 @red @native @accessibility
  Scenario: Detection degrades clearly without Accessibility permission
    Given microphone use is visible to Mimir
    And meeting application inspection requires Accessibility permission
    When Accessibility permission is denied
    Then Mimir reports that application-aware detection is unavailable
    And Mimir does not repeatedly request permission or infer an application identity

  @MTG-004 @red @native @security
  Scenario: Ignored applications and Do Not Disturb are respected
    Given an application is on the meeting-detection ignore list
    And meeting suggestions are configured to respect Do Not Disturb
    When the ignored application uses the microphone during Do Not Disturb
    Then Mimir does not present a meeting suggestion
    And detection does not start capture

  @MTG-005 @red @desktop @legal
  Scenario: A detected meeting requires deliberate recording consent
    Given Mimir has suggested a detected meeting
    And automatic calendar capture is disabled
    When the user dismisses the suggestion without choosing Record
    Then no capture session is armed
    And the dismissal does not count as recording consent

  @MTG-006 @red @desktop @legal @security
  Scenario: Hosted processing is disclosed before recording starts
    Given a hosted transcription route is selected
    When the user opens the recording confirmation
    Then Mimir identifies the hosted destination and the data it will receive
    And capture cannot start until the user deliberately confirms the route

  @MTG-007 @red @desktop @legal
  Scenario: Calendar automatic capture is a separate explicit policy
    Given calendar automatic capture is disabled by default
    When the user enables it after reviewing the recording and processing notice
    Then Mimir records the policy choice and its effective scope
    And microphone-based detection still cannot automatically start capture

  @MTG-008 @red @desktop @accessibility @legal
  Scenario: A persistent recording indicator follows native capture state
    Given native capture has become active
    When the user navigates away from the meeting surface
    Then the workbench and tray continue to identify the active recording
    And a one-step Stop control remains available until native capture is inactive
