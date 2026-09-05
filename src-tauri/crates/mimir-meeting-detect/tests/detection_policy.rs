use mimir_meeting_detect::{
    AppEvidence, CandidateEndReason, DetectionConfig, DetectionEvent, DetectionPolicy,
};
use std::time::Duration;

fn app(pid: i32, bundle_id: &str, name: &str) -> AppEvidence {
    AppEvidence {
        process_id: pid,
        bundle_id: Some(bundle_id.to_owned()),
        app_name: name.to_owned(),
    }
}

// MTG-001: sustained use is required before the suggestion is emitted.
#[test]
fn sustained_meeting_application_use_creates_one_local_suggestion() {
    let mut policy = DetectionPolicy::new(DetectionConfig {
        sustained_use: Duration::from_secs(3),
        ..DetectionConfig::default()
    })
    .unwrap();
    let zoom = app(42, "us.zoom.xos", "zoom.us");

    assert!(policy.observe(0, vec![zoom.clone()]).unwrap().is_empty());
    assert!(policy
        .observe(2_999, vec![zoom.clone()])
        .unwrap()
        .is_empty());
    let events = policy.observe(3_000, vec![zoom]).unwrap();

    assert_eq!(events.len(), 1);
    assert!(matches!(events[0], DetectionEvent::CandidateSuggested(_)));
    assert_eq!(policy.candidates().len(), 1);
}

// MTG-002: callbacks and fallback polling can report the same app repeatedly.
#[test]
fn repeated_equivalent_signals_are_coalesced() {
    let mut policy = DetectionPolicy::new(DetectionConfig {
        sustained_use: Duration::ZERO,
        ..DetectionConfig::default()
    })
    .unwrap();
    let teams = app(8, "com.microsoft.teams2", "Microsoft Teams");

    assert_eq!(policy.observe(10, vec![teams.clone()]).unwrap().len(), 1);
    assert!(policy.observe(11, vec![teams.clone()]).unwrap().is_empty());
    assert!(policy.observe(12, vec![teams]).unwrap().is_empty());
    assert_eq!(policy.candidates().len(), 1);
}

#[test]
fn slack_audio_helpers_are_grouped_under_the_human_facing_app() {
    let mut policy = DetectionPolicy::new(DetectionConfig {
        sustained_use: Duration::ZERO,
        ..DetectionConfig::default()
    })
    .unwrap();

    let events = policy
        .observe(
            0,
            vec![
                app(41, "com.tinyspeck.slackmacgap.helper", "Slack Helper"),
                app(42, "com.tinyspeck.slackmacgap.helper.renderer", "Helper"),
            ],
        )
        .unwrap();

    let DetectionEvent::CandidateSuggested(candidate) = &events[0] else {
        panic!("expected one Slack suggestion")
    };
    assert_eq!(events.len(), 1);
    assert_eq!(candidate.app_id, "com.tinyspeck.slackmacgap");
    assert_eq!(candidate.app_name, "Slack");
    assert_eq!(candidate.process_ids, vec![41, 42]);
}

#[test]
fn microphone_flapping_inside_absence_grace_does_not_duplicate() {
    let mut policy = DetectionPolicy::new(DetectionConfig {
        sustained_use: Duration::ZERO,
        absence_grace: Duration::from_secs(1),
        ..DetectionConfig::default()
    })
    .unwrap();
    let meet = app(9, "com.google.Chrome", "Google Chrome");

    assert_eq!(policy.observe(0, vec![meet.clone()]).unwrap().len(), 1);
    assert!(policy.observe(100, Vec::new()).unwrap().is_empty());
    assert!(policy.observe(900, vec![meet]).unwrap().is_empty());
    assert_eq!(policy.candidates().len(), 1);
}

#[test]
fn dismissal_starts_a_deterministic_cooldown() {
    let mut policy = DetectionPolicy::new(DetectionConfig {
        sustained_use: Duration::ZERO,
        cooldown: Duration::from_secs(5),
        ..DetectionConfig::default()
    })
    .unwrap();
    let slack = app(10, "com.tinyspeck.slackmacgap", "Slack");
    let suggested = policy.observe(0, vec![slack.clone()]).unwrap();
    let candidate_id = match &suggested[0] {
        DetectionEvent::CandidateSuggested(candidate) => candidate.id.clone(),
        event => panic!("unexpected event: {event:?}"),
    };

    let dismissed = policy.dismiss(&candidate_id, 1).unwrap().unwrap();
    assert!(matches!(
        dismissed,
        DetectionEvent::CandidateEnded {
            reason: CandidateEndReason::Dismissed,
            ..
        }
    ));
    assert!(policy
        .observe(4_999, vec![slack.clone()])
        .unwrap()
        .is_empty());
    assert!(policy.observe(5_001, vec![slack]).unwrap().is_empty());
    assert_eq!(policy.observe(5_002, Vec::new()).unwrap().len(), 0);
    assert_eq!(
        policy
            .observe(5_003, vec![app(10, "com.tinyspeck.slackmacgap", "Slack")])
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn mimir_and_ignored_apps_never_become_candidates() {
    let mut config = DetectionConfig {
        sustained_use: Duration::ZERO,
        ..DetectionConfig::default()
    };
    config
        .ignored_bundle_ids
        .insert("com.apple.VoiceMemos".to_owned());
    let mut policy = DetectionPolicy::new(config).unwrap();

    let events = policy
        .observe(
            0,
            vec![
                app(std::process::id() as i32, "com.abundanceds.mimir", "Mimir"),
                app(31, "com.abundanceds.mimir", "Mimir"),
                app(32, "com.apple.VoiceMemos", "Voice Memos"),
                app(33, "us.zoom.xos", "zoom.us"),
            ],
        )
        .unwrap();

    assert_eq!(events.len(), 1);
    assert_eq!(policy.candidates()[0].app_id, "us.zoom.xos");
}

#[test]
fn a_raced_helper_process_is_deduplicated_by_bundle_identity() {
    let mut policy = DetectionPolicy::new(DetectionConfig {
        sustained_use: Duration::ZERO,
        ..DetectionConfig::default()
    })
    .unwrap();

    policy
        .observe(
            0,
            vec![
                app(82, "com.google.Chrome", "Google Chrome Helper"),
                app(44, "com.google.Chrome", "Google Chrome"),
            ],
        )
        .unwrap();

    let candidates = policy.candidates();
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].process_ids, vec![44, 82]);
    assert_eq!(candidates[0].app_name, "Google Chrome");
}

#[test]
fn monotonic_time_regression_is_rejected_without_mutating_state() {
    let mut policy = DetectionPolicy::new(DetectionConfig::default()).unwrap();
    let zoom = app(42, "us.zoom.xos", "zoom.us");
    policy.observe(1_000, vec![zoom]).unwrap();

    let error = policy.observe(999, Vec::new()).unwrap_err();

    assert!(error.to_string().contains("monotonic"));
    assert_eq!(policy.tracked_len(), 1);
}
