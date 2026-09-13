//! One event-driven notification per detection occurrence. No waiting task or
//! notification-list polling survives an ignored banner.

use super::{MeetingNotificationAction, MeetingRecordRequest};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

type PermissionCompletion = Box<dyn FnOnce(bool) + Send>;
type DeliveryCompletion = Box<dyn FnOnce(Result<(), String>) + Send>;

trait NotificationPort: Send + Sync {
    fn authorize(&self, completion: PermissionCompletion);
    fn deliver(&self, id: &str, app_name: &str, completion: DeliveryCompletion);
    fn remove(&self, id: &str);
}

#[derive(Default)]
struct State {
    active: HashMap<String, Option<MeetingRecordRequest>>,
    stopped: bool,
}

struct Controller {
    state: Mutex<State>,
    port: Arc<dyn NotificationPort>,
}

impl Controller {
    fn new(port: Arc<dyn NotificationPort>) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State::default()),
            port,
        })
    }

    fn suggest(self: &Arc<Self>, request: MeetingRecordRequest) {
        let id = request.candidate_id.clone();
        let app_name = request.app_name.clone();
        {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            if state.stopped || state.active.contains_key(&id) {
                return;
            }
            state.active.insert(id.clone(), Some(request));
        }
        let owner = Arc::clone(self);
        self.port.authorize(Box::new(move |granted| {
            if !granted {
                owner.finish(&id);
                return;
            }
            if !owner.pending(&id) {
                return;
            }
            let delivered = Arc::clone(&owner);
            let delivery_id = id.clone();
            owner.port.deliver(
                &id,
                &app_name,
                Box::new(move |result| {
                    if let Err(error) = result {
                        log::debug!("Scribe notification delivery failed: {error}");
                        delivered.finish(&delivery_id);
                    }
                    // End can run between the pending check and native submission.
                    // Remove again after that asynchronous submission completes.
                    if !delivered.pending(&delivery_id) {
                        delivered.port.remove(&delivery_id);
                    }
                }),
            );
        }));
    }

    fn pending(&self, id: &str) -> bool {
        self.state
            .lock()
            .is_ok_and(|state| state.active.get(id).is_some_and(Option::is_some))
    }

    fn finish(&self, id: &str) -> Option<MeetingRecordRequest> {
        // Retain the empty entry until detection ends, preventing duplicate
        // suggestions or replays from prompting again during the same call.
        self.state.lock().ok()?.active.get_mut(id)?.take()
    }

    fn respond(
        &self,
        id: &str,
        action: Option<MeetingNotificationAction>,
    ) -> Option<MeetingRecordRequest> {
        let request = {
            let mut state = self.state.lock().ok()?;
            if state.stopped {
                return None;
            }
            let request = state.active.get_mut(id).and_then(Option::take);
            action.and_then(|action| {
                // A banner from an earlier launch still opens its destination.
                // Only a live, unconsumed occurrence can authorize RECORD.
                request
                    .or_else(|| {
                        (action == MeetingNotificationAction::Open).then(|| MeetingRecordRequest {
                            candidate_id: id.into(),
                            app_name: "Meeting app".into(),
                            action,
                        })
                    })
                    .map(|mut request| {
                        request.action = action;
                        request
                    })
            })
        };
        self.port.remove(id);
        request
    }

    fn end(&self, id: &str) {
        let removed = self
            .state
            .lock()
            .is_ok_and(|mut state| state.active.remove(id).is_some());
        if removed {
            self.port.remove(id);
        }
    }

    fn shutdown(&self) {
        let ids = self
            .state
            .lock()
            .map(|mut state| {
                state.stopped = true;
                state.active.drain().map(|(id, _)| id).collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for id in ids {
            self.port.remove(&id);
        }
    }
}

#[cfg(target_os = "macos")]
pub(super) use macos::DetectionNotifications;

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use crate::meetings::native::{open_record_request, MeetingRecordRequestQueue};
    use block2::{DynBlock, RcBlock};
    use mimir_meeting_detect::DetectionEvent;
    use objc2::{
        define_class, msg_send, rc::Retained, runtime::ProtocolObject, AnyThread, DefinedClass,
    };
    use objc2_foundation::{
        NSArray, NSBundle, NSError, NSObject, NSObjectProtocol, NSSet, NSString,
    };
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationAction,
        UNNotificationActionOptions, UNNotificationCategory, UNNotificationCategoryOptions,
        UNNotificationDefaultActionIdentifier, UNNotificationPresentationOptions,
        UNNotificationRequest, UNNotificationResponse, UNUserNotificationCenter,
        UNUserNotificationCenterDelegate,
    };

    const CATEGORY: &str = "mimir.scribe.detection";
    const REQUEST_PREFIX: &str = "mimir.scribe.candidate.";
    const RECORD_ACTION: &str = "mimir.scribe.record";

    pub struct DelegateState {
        app: tauri::AppHandle,
        controller: Arc<Controller>,
        requests: Arc<MeetingRecordRequestQueue>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "MimirScribeNotificationDelegate"]
        #[ivars = Arc<DelegateState>]
        struct DetectionDelegate;

        unsafe impl NSObjectProtocol for DetectionDelegate {}

        unsafe impl UNUserNotificationCenterDelegate for DetectionDelegate {
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                notification: &UNNotification,
                completion: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                let id = notification.request().identifier().to_string();
                let present = id.strip_prefix(REQUEST_PREFIX)
                    .is_some_and(|id| self.ivars().controller.pending(id));
                completion.call((if present {
                    UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List
                } else {
                    UNNotificationPresentationOptions::empty()
                },));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive_response(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion: &DynBlock<dyn Fn()>,
            ) {
                let id = response.notification().request().identifier().to_string();
                let action = response.actionIdentifier();
                if let Some(id) = id.strip_prefix(REQUEST_PREFIX) {
                    let action = if action.to_string() == RECORD_ACTION {
                        Some(MeetingNotificationAction::Record)
                    } else if *action == *unsafe { UNNotificationDefaultActionIdentifier } {
                        Some(MeetingNotificationAction::Open)
                    } else {
                        None
                    };
                    let state = self.ivars();
                    if let Some(request) = state.controller.respond(id, action) {
                        state.requests.enqueue(request);
                        let app = state.app.clone();
                        if let Err(error) = state.app.run_on_main_thread(move || open_record_request(&app)) {
                            log::error!("Scribe could not open the notification action: {error}");
                        }
                    }
                }
                completion.call(());
            }
        }
    );

    pub(in crate::meetings::native) struct DetectionNotifications {
        // The system's delegate property is weak. The engine owns this strong
        // reference from Tauri setup (before launch finishes) through shutdown.
        delegate: Retained<DetectionDelegate>,
    }

    impl Drop for DetectionNotifications {
        fn drop(&mut self) {
            self.shutdown();
        }
    }

    impl DetectionNotifications {
        pub(in crate::meetings::native) fn new(
            app: &tauri::AppHandle,
            requests: Arc<MeetingRecordRequestQueue>,
        ) -> Option<Self> {
            if !NSBundle::mainBundle()
                .bundlePath()
                .to_string()
                .ends_with(".app")
            {
                log::debug!("Scribe notifications require an app bundle");
                return None;
            }
            let center = UNUserNotificationCenter::currentNotificationCenter();
            let delegate = DetectionDelegate::alloc().set_ivars(Arc::new(DelegateState {
                app: app.clone(),
                controller: Controller::new(Arc::new(MacPort)),
                requests,
            }));
            // SAFETY: NSObject initialization accepts this allocated subclass.
            let delegate: Retained<DetectionDelegate> = unsafe { msg_send![super(delegate), init] };
            center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
            let action = UNNotificationAction::actionWithIdentifier_title_options(
                &NSString::from_str(RECORD_ACTION),
                &NSString::from_str("RECORD"),
                UNNotificationActionOptions::Foreground,
            );
            let category =
                UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
                    &NSString::from_str(CATEGORY),
                    &NSArray::from_retained_slice(&[action]),
                    &NSArray::new(),
                    UNNotificationCategoryOptions::CustomDismissAction,
                );
            // Scribe owns this modern center. Chat/Tracker use the separate
            // legacy center through Tauri's passive notification plugin.
            center.setNotificationCategories(&NSSet::from_retained_slice(&[category]));
            Some(Self { delegate })
        }

        pub(in crate::meetings::native) fn event_handler(
            &self,
        ) -> impl Fn(&DetectionEvent) + Send + Sync + 'static {
            let controller = Arc::clone(&self.delegate.ivars().controller);
            move |event| match event {
                DetectionEvent::CandidateSuggested(candidate) => {
                    controller.suggest(MeetingRecordRequest {
                        candidate_id: candidate.id.clone(),
                        app_name: candidate.app_name.clone(),
                        action: MeetingNotificationAction::Open,
                    })
                }
                DetectionEvent::CandidateEnded { candidate_id, .. } => controller.end(candidate_id),
            }
        }

        pub(in crate::meetings::native) fn shutdown(&self) {
            self.delegate.ivars().controller.shutdown();
        }
    }

    struct MacPort;

    impl NotificationPort for MacPort {
        fn authorize(&self, completion: PermissionCompletion) {
            let completion = Mutex::new(Some(completion));
            let callback =
                RcBlock::new(move |granted: objc2::runtime::Bool, error: *mut NSError| {
                    let callback = completion.lock().ok().and_then(|mut value| value.take());
                    if let Some(callback) = callback {
                        callback(error.is_null() && granted.as_bool());
                    }
                });
            UNUserNotificationCenter::currentNotificationCenter()
                .requestAuthorizationWithOptions_completionHandler(
                    UNAuthorizationOptions::Alert,
                    &callback,
                );
        }

        fn deliver(&self, id: &str, app_name: &str, completion: DeliveryCompletion) {
            let mut name = app_name.trim().chars().take(48).collect::<String>();
            if app_name.trim().chars().count() > 48 {
                name.push('…');
            }
            let content = UNMutableNotificationContent::new();
            content.setTitle(&NSString::from_str("Meeting detected"));
            content.setBody(&NSString::from_str(&format!(
                "Open Scribe to record {name}."
            )));
            content.setCategoryIdentifier(&NSString::from_str(CATEGORY));
            let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
                &request_id(id),
                &content,
                None,
            );
            let completion = Mutex::new(Some(completion));
            let callback = RcBlock::new(move |error: *mut NSError| {
                let callback = completion.lock().ok().and_then(|mut value| value.take());
                if let Some(callback) = callback {
                    // SAFETY: The system owns this optional error for the callback's duration.
                    callback(unsafe { error.as_ref() }.map_or(Ok(()), |error| {
                        Err(error.localizedDescription().to_string())
                    }));
                }
            });
            UNUserNotificationCenter::currentNotificationCenter()
                .addNotificationRequest_withCompletionHandler(&request, Some(&callback));
        }

        fn remove(&self, id: &str) {
            let ids = NSArray::from_retained_slice(&[request_id(id)]);
            let center = UNUserNotificationCenter::currentNotificationCenter();
            center.removePendingNotificationRequestsWithIdentifiers(&ids);
            center.removeDeliveredNotificationsWithIdentifiers(&ids);
        }
    }

    fn request_id(id: &str) -> Retained<NSString> {
        NSString::from_str(&format!("{REQUEST_PREFIX}{id}"))
    }
}

#[cfg(test)]
mod tests;
