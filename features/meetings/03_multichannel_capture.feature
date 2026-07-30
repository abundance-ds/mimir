@meetings @audio @capture
Feature: Capture microphone and system audio without sacrificing durability
  Recording is authoritative and independent from slower transcription work.
  Every discontinuity is explicit rather than hidden by a plausible transcript.

  @MTG-040 @manual @native @hardware
  Scenario: Microphone and system audio remain separate and aligned
    Given microphone and system audio permissions are available
    When a meeting is captured from both sources
    Then Mimir durably retains separately attributable tracks
    And both tracks share monotonic meeting-time coordinates

  @MTG-041 @automated @native @security
  Scenario: A required unavailable channel prevents false recording success
    Given microphone capture is available but system audio is unavailable
    When the user attempts dual-channel capture
    Then native start fails with an actionable channel error
    And the session is never reported as recording or complete

  @MTG-042 @manual @native @hardware
  Scenario: Muting the microphone does not suppress system audio
    Given dual-channel capture is active
    When the user mutes the microphone through Mimir
    Then the microphone channel records intentional silence
    And the system-audio channel continues with uninterrupted time coordinates

  @MTG-043 @manual @native @hardware
  Scenario: A device route change restarts only the affected source
    Given dual-channel capture is active
    When the selected microphone is disconnected and a replacement is chosen
    Then the microphone source restarts within the same capture run
    And any unavailable interval is represented as a timed gap

  @MTG-044 @manual @domain @performance @hardware
  Scenario: Channel drift remains within the release budget
    Given synthetic microphone and system tracks share known alignment markers
    When they are captured for the release soak duration
    Then their corrected drift remains within the manifest performance budget
    And the correction history remains diagnostic without changing raw provenance

  @MTG-045 @automated @native @performance
  Scenario: Slow transcription cannot block the recorder
    Given the transcription consumer is stalled
    When audio continues to arrive at the real-time source
    Then the recorder continues writing within its bounded queue policy
    And transcription reports backlog or a gap without stalling the audio callback

  @MTG-046 @automated @native @security
  Scenario: Disk exhaustion cannot produce a false successful recording
    Given capture is active near the configured disk reserve
    When the recording writer can no longer commit a recoverable chunk
    Then native capture transitions to a visible fatal recording error
    And the meeting is not marked ready or complete

  @MTG-047 @manual @native @hardware
  Scenario: Sleep and wake produce an explicit continuity result
    Given capture is active before the computer sleeps
    When the computer wakes and audio devices become available again
    Then capture either resumes the existing run or ends it recoverably
    And the sleeping interval is never represented as captured speech

  @MTG-048 @automated @native @security
  Scenario: Canonical resampling preserves durable source provenance
    Given device audio requires canonical rate or channel conversion
    When normalized frames are used for recording and transcription
    Then each durable chunk retains its source channel and time coordinates
    And conversion never fabricates or silently hides missing source frames
