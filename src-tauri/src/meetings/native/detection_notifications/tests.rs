use super::*;
use std::collections::{HashSet, VecDeque};

#[derive(Default)]
struct FakePort {
    permissions: Mutex<VecDeque<PermissionCompletion>>,
    submissions: Mutex<VecDeque<(String, DeliveryCompletion)>>,
    delivered: Mutex<HashSet<String>>,
}

impl NotificationPort for FakePort {
    fn authorize(&self, completion: PermissionCompletion) {
        self.permissions.lock().unwrap().push_back(completion);
    }
    fn deliver(&self, id: &str, _app_name: &str, completion: DeliveryCompletion) {
        self.submissions
            .lock()
            .unwrap()
            .push_back((id.into(), completion));
    }
    fn remove(&self, id: &str) {
        self.delivered.lock().unwrap().remove(id);
    }
}

impl FakePort {
    fn grant(&self, granted: bool) {
        let callback = self.permissions.lock().unwrap().pop_front().unwrap();
        callback(granted);
    }
    fn complete(&self, success: bool) {
        let (id, callback) = self.submissions.lock().unwrap().pop_front().unwrap();
        if success {
            self.delivered.lock().unwrap().insert(id);
        }
        callback(if success {
            Ok(())
        } else {
            Err("delivery rejected".into())
        });
    }
    fn is_clear(&self) -> bool {
        self.permissions.lock().unwrap().is_empty()
            && self.submissions.lock().unwrap().is_empty()
            && self.delivered.lock().unwrap().is_empty()
    }
}

fn setup() -> (Arc<Controller>, Arc<FakePort>) {
    let port = Arc::new(FakePort::default());
    (Controller::new(port.clone()), port)
}

fn request(id: &str) -> MeetingRecordRequest {
    MeetingRecordRequest {
        candidate_id: id.into(),
        app_name: "Zoom".into(),
        action: MeetingNotificationAction::Open,
    }
}

#[test]
fn ten_thousand_ignored_calls_release_native_requests_and_callbacks() {
    let (owner, port) = setup();
    for n in 0..10_000 {
        let id = n.to_string();
        owner.suggest(request(&id));
        port.grant(true);
        port.complete(true);
        assert!(owner.pending(&id));
        owner.end(&id);
        assert!(!owner.pending(&id));
        assert!(owner.state.lock().unwrap().active.is_empty());
        assert!(port.is_clear());
    }
}

#[test]
fn thirty_pending_banners_are_removed_on_shutdown_without_waiting_for_response() {
    let (owner, port) = setup();
    for n in 0..30 {
        owner.suggest(request(&n.to_string()));
        port.grant(true);
        port.complete(true);
    }
    assert_eq!(port.delivered.lock().unwrap().len(), 30);
    owner.shutdown();
    owner.shutdown();
    assert!(owner.state.lock().unwrap().active.is_empty());
    assert!(port.is_clear());
    owner.suggest(request("after-shutdown"));
    assert!(port.is_clear());
}

#[test]
fn permission_and_submission_callbacks_cannot_restore_ended_or_stopped_calls() {
    for shutdown in [false, true] {
        for during_submission in [false, true] {
            let (owner, port) = setup();
            owner.suggest(request("old"));
            if during_submission {
                port.grant(true);
            }
            if shutdown {
                owner.shutdown();
            } else {
                owner.end("old");
            }
            if during_submission {
                port.complete(true);
            } else {
                port.grant(true);
            }
            assert!(port.is_clear());
            assert!(!owner.pending("old"));
            assert!(owner
                .respond("old", Some(MeetingNotificationAction::Record))
                .is_none());
        }
    }
}

#[test]
fn denied_permission_or_delivery_failure_does_not_retry_during_the_same_call() {
    for delivery_failure in [false, true] {
        let (owner, port) = setup();
        owner.suggest(request("one"));
        port.grant(delivery_failure);
        if delivery_failure {
            port.complete(false);
        }
        owner.suggest(request("one"));
        assert!(port.is_clear());
        assert!(!owner.pending("one"));
        owner.end("one");
        assert!(owner.state.lock().unwrap().active.is_empty());
    }
}

#[test]
fn banner_and_record_actions_are_distinct_and_accepted_only_once() {
    for action in [
        Some(MeetingNotificationAction::Open),
        Some(MeetingNotificationAction::Record),
        None,
    ] {
        let (owner, port) = setup();
        owner.suggest(request("one"));
        owner.suggest(request("one"));
        port.grant(true);
        port.complete(true);
        let result = owner.respond("one", action);
        assert_eq!(result.map(|request| request.action), action);
        assert!(port.is_clear());
        assert!(owner
            .respond("one", Some(MeetingNotificationAction::Record))
            .is_none());
        owner.suggest(request("one"));
        assert!(port.is_clear());
        owner.end("one");
        assert!(owner.state.lock().unwrap().active.is_empty());
    }
}

#[test]
fn old_response_and_delivery_completion_cannot_affect_a_later_call() {
    let (owner, port) = setup();
    owner.suggest(request("call-a"));
    port.grant(true);
    owner.end("call-a");
    owner.suggest(request("call-b"));
    port.grant(true);
    port.complete(true); // late completion for A
    port.complete(true);
    assert_eq!(
        *port.delivered.lock().unwrap(),
        HashSet::from(["call-b".into()])
    );
    assert!(owner
        .respond("call-a", Some(MeetingNotificationAction::Record))
        .is_none());
    assert!(owner.pending("call-b"));
    assert_eq!(
        owner
            .respond("call-b", Some(MeetingNotificationAction::Record))
            .unwrap()
            .candidate_id,
        "call-b"
    );
    assert!(port.is_clear());
}

#[test]
fn delivery_completion_after_response_does_not_restore_the_banner() {
    let (owner, port) = setup();
    owner.suggest(request("one"));
    port.grant(true);
    assert!(owner
        .respond("one", Some(MeetingNotificationAction::Open))
        .is_some());
    port.complete(true);
    assert!(port.is_clear());
}

#[test]
fn a_banner_from_an_earlier_launch_opens_scribe_but_cannot_record() {
    let (owner, _) = setup();
    assert!(owner
        .respond("earlier-launch", Some(MeetingNotificationAction::Record))
        .is_none());
    assert_eq!(
        owner
            .respond("earlier-launch", Some(MeetingNotificationAction::Open))
            .unwrap()
            .action,
        MeetingNotificationAction::Open
    );
    owner.shutdown();
    assert!(owner
        .respond("earlier-launch", Some(MeetingNotificationAction::Open))
        .is_none());
}
