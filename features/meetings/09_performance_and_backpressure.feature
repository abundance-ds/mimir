@meetings @performance
Feature: Meet bounded real-time and scale budgets
  Capture quality must not depend on provider speed, transcript size, or a
  renderer keeping up with native events.

  @MTG-180 @manual @native @hardware @performance @release
  Scenario: Release soak captures four hours without unreported frame loss
    Given the release reference machine and dual-channel synthetic markers
    When capture runs for four hours under the documented workload
    Then every missing frame is zero or represented by a timed gap
    And CPU, memory, callback latency, disk, and drift remain within manifest budgets

  @MTG-181 @automated @domain @performance
  Scenario: Every meeting pipeline queue has a bounded policy
    Given recorder, live transcription, renderer projection, batch, and hook queues exist
    When a producer exceeds a consumer's sustained rate
    Then each queue applies its documented bound and overflow behavior
    And recorder authority cannot be blocked by a downstream queue

  @MTG-182 @automated @native @performance
  Scenario: Provider backlog remains bounded and independent from capture
    Given live transcription and dual-channel recording are active
    When the provider stops consuming audio beyond the replay bounds
    Then the real-time callback and recorder remain independent
    And transcription exposes backlog, bounded replay, or an explicit gap

  @MTG-183 @manual @renderer @performance @accessibility
  Scenario: A large transcript remains responsive and navigable
    Given a meeting contains at least one hundred thousand words
    When the user opens, scrolls, searches, and selects transcript content
    Then projection and interaction remain within manifest responsiveness budgets
    And keyboard and assistive-technology semantics remain complete

  @MTG-184 @manual @native @performance @hardware
  Scenario: Repeated lifecycle operations do not leak resources
    Given meeting detection and audio devices are available
    When one hundred start, stop, finalize, and reopen cycles complete
    Then native device handles, tasks, listeners, buffers, and jobs return to their stable baseline
    And no stale run can receive new frames

  @MTG-185 @manual @native @performance @hardware
  Scenario: Long-running detection remains bounded
    Given meeting detection is enabled without active capture
    When it runs for twenty-four hours across application and device changes
    Then CPU, memory, handles, and notification count remain within manifest budgets
    And detection retains no audio samples

  @MTG-186 @manual @contract @performance @release
  Scenario: Accuracy is guarded by a licensed versioned corpus
    Given a supported model, language, and approved reference corpus
    When the release transcription suite computes word, timing, and attribution metrics
    Then each metric meets its model-specific baseline and regression tolerance
    And corpus, model, adapter, and scoring versions are recorded with the evidence
