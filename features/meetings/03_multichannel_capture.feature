@meetings @audio @capture
Feature: Capture microphone and system audio without sacrificing durability
  Recording is authoritative and independent from slower transcription work.
  Every discontinuity is explicit rather than hidden by a plausible transcript.

  @MTG-040 @red @native @hardware
  Scenario: Microphone and system audio remain separate and aligned
    Given microphone and system audio permissions are available
    When a meeting is captured from both sources
    Then Mimir durably retains separately attributable tracks
    And both tracks share monotonic meeting-time coordinates

  @MTG-041 @red @native @hardware
  Scenario: One unavailable channel creates a degraded recording
    Given microphone capture is available but system audio is unavailable
    When the user deliberately continues with microphone-only capture
    Then Mimir records the available channel
    And the session retains an explicit missing-system-audio marker

  @MTG-042 @red @native @hardware
  Scenario: Muting the microphone does not suppress system audio
    Given dual-channel capture is active
    When the user mutes the microphone through Mimir
    Then the microphone channel records intentional silence
    And the system-audio channel continues with uninterrupted time coordinates

  @MTG-043 @red @native @hardware
  Scenario: A device route change restarts only the affected source
    Given dual-channel capture is active
    When the selected microphone is disconnected and a replacement is chosen
    Then the microphone source restarts within the same capture run
    And any unavailable interval is represented as a timed gap

  @MTG-044 @red @domain @performance
  Scenario: Channel drift remains within the release budget
    Given synthetic microphone and system tracks share known alignment markers
    When they are captured for the release soak duration
    Then their corrected drift remains within the manifest performance budget
    And the correction history remains diagnostic without changing raw provenance

  @MTG-045 @red @native @performance
  Scenario: Slow transcription cannot block the recorder
    Given the transcription consumer is stalled
    When audio continues to arrive at the real-time source
    Then the recorder continues writing within its bounded queue policy
    And transcription reports backlog or a gap without stalling the audio callback

  @MTG-046 @red @native @security
  Scenario: Disk exhaustion cannot produce a false successful recording
    Given capture is active near the configured disk reserve
    When the recording writer can no longer commit a recoverable chunk
    Then native capture transitions to a visible fatal recording error
    And the meeting is not marked ready or complete

  @MTG-047 @red @native @hardware
  Scenario: Sleep and wake produce an explicit continuity result
    Given capture is active before the computer sleeps
    When the computer wakes and audio devices become available again
    Then capture either resumes the existing run or ends it recoverably
    And the sleeping interval is never represented as captured speech

  @MTG-048 @red @native @security
  Scenario: Audio processing preserves archival provenance
    Given echo cancellation, normalization, or voice activity detection is enabled
    When processed audio is used for transcription
    Then Mimir retains which transform produced each transcription source
    And destructive processing never silently replaces the archival source
