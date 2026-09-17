import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export const MEETING_EVENT = 'mimir://meeting-event'
export const MEETING_PLATFORM_CHANGED_EVENT = 'mimir://meeting-platform-changed'
export const MEETING_AUDIO_TEST_EVENT = 'mimir://meeting-audio-test'
export const MEETING_RECORD_REQUESTED_EVENT = 'mimir://meeting-record-requested'
export const TRANSCRIPT_PAGE_SIZE = 250
const MAX_MEETING_TAGS = 64
const MAX_MEETING_TAG_CHARS = 80
const MAX_MEETING_TAG_BYTES = 160

export async function loadMeetingSnapshot() {
  return normalizeMeetingSnapshot(await invoke('meetings_snapshot'))
}

export async function loadMeeting(meetingId) {
  return normalizeMeeting(await invoke('meetings_get', {
    meetingId: requiredId(meetingId, 'meeting'),
  }))
}

export async function prepareMeeting(request = {}) {
  return normalizeMeetingSnapshot(await invoke('meetings_prepare', {
    request: {
      title: optionalString(request.title),
      workspacePath: optionalString(request.workspacePath),
    },
  }))
}

export async function fileMeetingToGraph(request = {}) {
  return invoke('meetings_file_to_graph', {
    request: {
      meetingId: requiredId(request.meetingId, 'meeting'),
      scopeId: requiredString(request.scopeId, 'Graph scope'),
      projectId: optionalString(request.projectId),
      peopleIds: uniqueStrings(request.peopleIds),
    },
  })
}

export async function loadMeetingTranscriptPage(
  meetingId,
  before = null,
  limit = TRANSCRIPT_PAGE_SIZE,
) {
  return normalizeMeetingTranscriptPage(await invoke('meetings_transcript_page', {
    meetingId: requiredId(meetingId, 'meeting'),
    before: before ? normalizeTranscriptCursor(before) : null,
    limit: Math.min(TRANSCRIPT_PAGE_SIZE, Math.max(1, nonnegativeInteger(limit))),
  }))
}

export async function loadMeetingLibraryPage(before, limit = 200) {
  return normalizeMeetingLibraryPage(await invoke('meetings_library_page', {
    before: before ? normalizeMeetingLibraryCursor(before) : null,
    limit: Math.min(200, Math.max(1, nonnegativeInteger(limit))),
  }))
}

export async function searchMeetingLibrary(query, limit = 50) {
  const normalized = String(query || '').trim()
  if ([...normalized].length < 3) return []
  const hits = await invoke('meetings_search_library', {
    query: normalized,
    limit: Math.min(100, Math.max(1, nonnegativeInteger(limit))),
  })
  return (Array.isArray(hits) ? hits : [])
    .filter(isPlainObject)
    .map(normalizeMeetingSearchHit)
}

export async function requestMeetingMicrophonePermission() {
  return normalizeMeetingSnapshot(await invoke('meetings_request_microphone_permission'))
}

export async function requestMeetingSystemAudioPermission() {
  return normalizeMeetingSnapshot(await invoke('meetings_request_system_audio_permission'))
}

export async function openMeetingSystemAudioSettings() {
  return invoke('meetings_open_system_audio_settings')
}

export async function checkMeetingAudio() {
  const value = object(await invoke('meetings_check_audio'))
  const status = source => {
    const normalized = String(source || '')
    return ['signal', 'silent', 'no-data'].includes(normalized) ? normalized : 'no-data'
  }
  return {
    microphone: status(value.microphone),
    systemAudio: status(value.systemAudio ?? value.system_audio),
    microphoneLevel: Math.min(100, nonnegativeInteger(
      value.microphoneLevel ?? value.microphone_level,
    )),
    systemAudioLevel: Math.min(100, nonnegativeInteger(
      value.systemAudioLevel ?? value.system_audio_level,
    )),
    runtimeIdentity: (value.runtimeIdentity ?? value.runtime_identity) === 'mimir'
      ? 'mimir'
      : 'development-host',
    observedMs: nonnegativeInteger(value.observedMs ?? value.observed_ms),
  }
}

export async function loadMeetingMicrophones() {
  const value = object(await invoke('meetings_microphone_devices'))
  return {
    selectedDeviceId: optionalString(value.selectedDeviceId ?? value.selected_device_id),
    selectedAvailable: Boolean(value.selectedAvailable ?? value.selected_available),
    effectiveDeviceId: optionalString(value.effectiveDeviceId ?? value.effective_device_id),
    fallbackReason: optionalString(value.fallbackReason ?? value.fallback_reason),
    devices: (Array.isArray(value.devices) ? value.devices : [])
      .filter(isPlainObject)
      .map(device => ({
        id: String(device.id || ''),
        name: String(device.name || 'Microphone'),
        isDefault: Boolean(device.isDefault ?? device.is_default),
      }))
      .filter(device => device.id),
  }
}

export async function startMeetingAudioTest() {
  const value = object(await invoke('meetings_audio_test_start'))
  return {
    testId: requiredId(value.testId ?? value.test_id, 'audio test'),
    requestedMicrophoneDeviceId: optionalString(
      value.requestedMicrophoneDeviceId ?? value.requested_microphone_device_id,
    ),
  }
}

export async function stopMeetingAudioTest(testId) {
  return invoke('meetings_audio_test_stop', {
    testId: requiredId(testId, 'audio test'),
  })
}

export async function listenToMeetingAudioTestEvents(onEvent) {
  if (typeof onEvent !== 'function') throw new Error('An audio test handler is required.')
  return listen(MEETING_AUDIO_TEST_EVENT, event => {
    onEvent(normalizeMeetingAudioTestEvent(event?.payload))
  })
}

export async function dismissMeetingCandidate(candidateId) {
  return normalizeMeetingSnapshot(await invoke('meetings_dismiss_candidate', {
    candidateId: requiredId(candidateId, 'meeting candidate'),
  }))
}

export async function takeMeetingRecordRequests() {
  const requests = await invoke('meetings_take_record_requests')
  return (Array.isArray(requests) ? requests : [])
    .map(normalizeMeetingRecordRequest)
    .filter(request => request.candidateId)
}

export async function listenToMeetingRecordRequests(onPending) {
  if (typeof onPending !== 'function') {
    throw new Error('A meeting record-request handler is required.')
  }
  return listen(MEETING_RECORD_REQUESTED_EVENT, () => onPending())
}

export async function issueMeetingStartConsent(disclosure = {}) {
  const mode = String(disclosure.transcriptionMode || '').trim()
  if (!['local', 'custom'].includes(mode)) {
    throw new Error('Recording disclosure must identify local or custom transcription.')
  }
  const grant = await invoke('meetings_issue_start_consent', {
    disclosure: {
      candidateId: optionalString(disclosure.candidateId),
      candidateAppName: optionalString(disclosure.candidateAppName),
      continueMeetingId: optionalString(disclosure.continueMeetingId),
      transcriptionMode: mode,
      destination: mode === 'custom' ? optionalString(disclosure.destination) : null,
      model: requiredId(disclosure.model, 'transcription model'),
    },
  })
  const value = object(grant)
  return {
    token: requiredId(value.token, 'native recording consent token'),
    requestId: requiredId(value.requestId ?? value.request_id, 'native recording request'),
    expiresInMs: nonnegativeInteger(value.expiresInMs ?? value.expires_in_ms),
    disclosure: object(value.disclosure),
  }
}

export async function startMeeting(request = {}) {
  return normalizeMeetingSnapshot(await invoke('meetings_start', {
    request: {
      requestId: requiredId(request.requestId, 'native recording request'),
      title: optionalString(request.title),
      workspacePath: optionalString(request.workspacePath),
      candidateId: optionalString(request.candidateId),
      continueMeetingId: optionalString(request.continueMeetingId),
      consentToken: requiredId(request.consentToken, 'native recording consent token'),
    },
  }))
}

export async function stopMeeting(meetingId) {
  return normalizeMeetingSnapshot(await invoke('meetings_stop', {
    meetingId: requiredId(meetingId, 'meeting'),
  }))
}

export async function signalMeetingStop(meetingId) {
  await invoke('meetings_signal_stop', {
    meetingId: requiredId(meetingId, 'meeting'),
  })
}

export async function setMeetingMicMuted(meetingId, muted) {
  return normalizeMeetingSnapshot(await invoke('meetings_set_mic_muted', {
    meetingId: requiredId(meetingId, 'meeting'),
    muted: Boolean(muted),
  }))
}

export async function updateMeeting(meetingId, patch = {}) {
  return normalizeMeetingSnapshot(await invoke('meetings_update', {
    meetingId: requiredId(meetingId, 'meeting'),
    patch: {
      ...(patch.title == null ? {} : { title: String(patch.title).trim() }),
      ...(patch.summary == null ? {} : { summary: String(patch.summary) }),
      ...(patch.notes == null ? {} : { notes: String(patch.notes) }),
      ...(patch.tags == null ? {} : {
        tags: serializeMeetingTags(patch.tags),
      }),
      ...(patch.graphNodeId == null ? {} : { graphNodeId: String(patch.graphNodeId).trim() }),
      ...(patch.graphDraft == null ? {} : { graphDraft: serializeMeetingGraphDraft(patch.graphDraft) }),
    },
  }))
}

export async function decideMeetingKgProposal(meetingId, decision) {
  const normalized = String(decision || '').trim()
  if (!['create-draft', 'not-now', 'never'].includes(normalized)) {
    throw new Error('Choose whether to create a knowledge-graph draft.')
  }
  return normalizeMeetingSnapshot(await invoke('meetings_decide_kg', {
    meetingId: requiredId(meetingId, 'meeting'),
    decision: normalized,
  }))
}

export async function retryMeetingJob(meetingId, jobKind) {
  const kind = String(jobKind || '').trim()
  if (!['title-summary', 'kg-proposal', 'transcription'].includes(kind)) {
    throw new Error('Choose a meeting job to retry.')
  }
  return normalizeMeetingSnapshot(await invoke('meetings_retry_job', {
    meetingId: requiredId(meetingId, 'meeting'),
    jobKind: kind,
  }))
}

export async function runMeetingSummary(meetingId, request = {}) {
  const template = String(request.template || '').trim()
  if (!['standard', 'brief', 'decisions-actions', 'detailed'].includes(template)) {
    throw new Error('Choose a valid summary format.')
  }
  const prompt = String(request.prompt ?? '')
  if (!prompt.trim()) throw new Error('Enter a summary prompt.')
  if ([...prompt].length > 16_000) throw new Error('Summary prompt cannot exceed 16000 characters.')
  const preset = String(request.preset || '').trim()
  return normalizeMeetingSnapshot(await invoke('meetings_run_summary', {
    meetingId: requiredId(meetingId, 'meeting'),
    request: { template, prompt, preset },
  }))
}

export async function retranscribeMeeting(meetingId) {
  return normalizeMeetingSnapshot(await invoke('meetings_retranscribe', {
    meetingId: requiredId(meetingId, 'meeting'),
  }))
}

export async function prepareMeetingFollowUpContext(meetingId) {
  const value = object(await invoke('meetings_follow_up_context', {
    meetingId: requiredId(meetingId, 'meeting'),
  }))
  return {
    meetingId: requiredId(value.meetingId ?? value.meeting_id, 'meeting'),
    transcriptRevision: nonnegativeInteger(
      value.transcriptRevision ?? value.transcript_revision,
    ),
    transcriptPath: requiredString(
      value.transcriptPath ?? value.transcript_path,
      'meeting transcript path',
    ),
  }
}

export async function deleteMeeting(meetingId, mode = 'all') {
  const normalized = String(mode || '').trim()
  if (!['audio', 'all'].includes(normalized)) {
    throw new Error('Meeting deletion mode must be audio or all.')
  }
  return normalizeMeetingSnapshot(await invoke('meetings_delete', {
    meetingId: requiredId(meetingId, 'meeting'),
    mode: normalized,
  }))
}

export async function exportMeeting(meetingId, format = 'markdown') {
  const normalized = String(format || '').trim()
  if (!['markdown', 'json', 'audio', 'files'].includes(normalized)) {
    throw new Error('Meeting export format must be markdown, json, audio, or files.')
  }
  return invoke('meetings_export', {
    meetingId: requiredId(meetingId, 'meeting'),
    format: normalized,
  })
}

export async function showMeetingFiles(meetingId) {
  const exported = await exportMeeting(meetingId, 'files')
  await revealMeetingExport(exported)
  return exported
}

export async function exportMeetingToFinder(meetingId, format) {
  const exported = await exportMeeting(meetingId, format)
  await revealMeetingExport(exported)
  return exported
}

async function revealMeetingExport(exported) {
  const path = String(exported?.path || '').trim()
  if (!path) throw new Error('Meeting files are unavailable.')
  await invoke('reveal_in_finder', { path })
}

export async function updateMeetingsConfig(patch = {}) {
  return normalizeMeetingSnapshot(await invoke('meetings_update_config', {
    patch: serializeConfigPatch(patch),
  }))
}

export async function setMeetingsApiKey(apiKey) {
  const value = String(apiKey || '').trim()
  if (!value) throw new Error('Enter an API key.')
  return normalizeMeetingSnapshot(await invoke('meetings_set_api_key', { apiKey: value }))
}

export async function clearMeetingsApiKey() {
  return normalizeMeetingSnapshot(await invoke('meetings_clear_api_key'))
}

export async function installMeetingModel(modelId) {
  return normalizeMeetingSnapshot(await invoke('meetings_install_model', {
    modelId: requiredId(modelId, 'model'),
  }))
}

export async function deleteMeetingModel(modelId) {
  return normalizeMeetingSnapshot(await invoke('meetings_delete_model', {
    modelId: requiredId(modelId, 'model'),
  }))
}

export async function listenToMeetingEvents(onEvent) {
  if (typeof onEvent !== 'function') throw new Error('A meeting event handler is required.')
  const stopMeeting = await listen(
    MEETING_EVENT,
    event => onEvent(normalizeMeetingEvent(event?.payload)),
  )
  try {
    const stopPlatform = await listen(
      MEETING_PLATFORM_CHANGED_EVENT,
      event => onEvent({
        kind: String(event?.payload?.kind || 'platform-changed'),
        meetingId: optionalString(event?.payload?.meetingId ?? event?.payload?.meeting_id),
        refresh: true,
      }),
    )
    return () => {
      stopMeeting()
      stopPlatform()
    }
  } catch (error) {
    stopMeeting()
    throw error
  }
}

export function normalizeMeetingSnapshot(value) {
  const snapshot = object(value)
  const meetings = (Array.isArray(snapshot.meetings) ? snapshot.meetings : [])
    .filter(isPlainObject)
    .map(normalizeMeeting)
    .sort(compareMeetings)
  const activeId = optionalString(snapshot.activeMeetingId ?? snapshot.active_meeting_id)
  return {
    revision: nonnegativeInteger(snapshot.revision),
    meetings,
    startProjection: Boolean(snapshot.startProjection ?? snapshot.start_projection),
    meetingsTruncated: Boolean(snapshot.meetingsTruncated ?? snapshot.meetings_truncated),
    nextMeetingsBefore: snapshot.nextMeetingsBefore || snapshot.next_meetings_before
      ? normalizeMeetingLibraryCursor(
        snapshot.nextMeetingsBefore ?? snapshot.next_meetings_before,
      )
      : null,
    activeMeetingId: activeId,
    activeMeeting: meetings.find(meeting => meeting.id === activeId) || null,
    candidates: (Array.isArray(snapshot.candidates) ? snapshot.candidates : [])
      .filter(isPlainObject)
      .map(normalizeCandidate),
    config: normalizeMeetingsConfig(snapshot.config),
    permissions: normalizePermissions(snapshot.permissions),
    models: (Array.isArray(snapshot.models) ? snapshot.models : [])
      .filter(isPlainObject)
      .map(normalizeModel),
    diagnostic: optionalString(snapshot.diagnostic),
  }
}

export function normalizeMeetingLibraryPage(value) {
  const page = object(value)
  return {
    meetings: (Array.isArray(page.meetings) ? page.meetings : [])
      .filter(isPlainObject)
      .slice(0, 200)
      .map(normalizeMeeting),
    hasMore: Boolean(page.hasMore ?? page.has_more),
    nextBefore: page.nextBefore || page.next_before
      ? normalizeMeetingLibraryCursor(page.nextBefore ?? page.next_before)
      : null,
  }
}

export function normalizeMeetingTranscriptPage(value) {
  const page = object(value)
  return {
    meetingId: String(page.meetingId ?? page.meeting_id ?? ''),
    revision: nonnegativeInteger(page.revision),
    totalSegments: nonnegativeInteger(page.totalSegments ?? page.total_segments),
    hasMore: Boolean(page.hasMore ?? page.has_more),
    nextBefore: page.nextBefore || page.next_before
      ? normalizeTranscriptCursor(page.nextBefore ?? page.next_before)
      : null,
    segments: (Array.isArray(page.segments) ? page.segments : [])
      .filter(isPlainObject)
      .slice(0, TRANSCRIPT_PAGE_SIZE)
      .map(normalizeSegment),
    summary: optionalString(page.summary),
  }
}

export function normalizeMeetingEvent(value) {
  const event = object(value)
  return {
    revision: nonnegativeInteger(event.revision),
    runId: optionalString(event.runId ?? event.run_id),
    meetingId: optionalString(event.meetingId ?? event.meeting_id),
    kind: String(event.kind || 'changed'),
    snapshot: event.snapshot ? normalizeMeetingSnapshot(event.snapshot) : null,
  }
}

function normalizeMeeting(value) {
  const meeting = object(value)
  return {
    id: String(meeting.id || ''),
    title: String(meeting.title || 'Untitled meeting'),
    lifecycle: String(meeting.lifecycle || 'ready'),
    transcription: String(meeting.transcription || meeting.transcriptionState || 'idle'),
    startedAt: optionalString(meeting.startedAt ?? meeting.started_at),
    recordingStartedAt: optionalString(
      meeting.recordingStartedAt ?? meeting.recording_started_at,
    ),
    stoppedAt: optionalString(meeting.stoppedAt ?? meeting.stopped_at),
    durationMs: nonnegativeInteger(meeting.durationMs ?? meeting.duration_ms),
    workspacePath: optionalString(meeting.workspacePath ?? meeting.workspace_path),
    sourceApp: optionalString(meeting.sourceApp ?? meeting.source_app),
    micMuted: Boolean(meeting.micMuted ?? meeting.mic_muted),
    channels: uniqueStrings(meeting.channels),
    tags: normalizeMeetingTags(meeting.tags),
    gaps: (Array.isArray(meeting.gaps) ? meeting.gaps : [])
      .filter(isPlainObject)
      .map(gap => ({
        channel: String(gap.channel || 'unknown'),
        startMs: nonnegativeInteger(gap.startMs ?? gap.start_ms),
        endMs: nonnegativeInteger(gap.endMs ?? gap.end_ms),
        reason: String(gap.reason || 'capture-gap'),
      })),
    gapCount: nonnegativeInteger(meeting.gapCount ?? meeting.gap_count),
    transcriptRevision: nonnegativeInteger(
      meeting.transcriptRevision ?? meeting.transcript_revision,
    ),
    transcriptFinal: Boolean(meeting.transcriptFinal ?? meeting.transcript_final),
    segmentCount: nonnegativeInteger(meeting.segmentCount ?? meeting.segment_count),
    transcriptAllFinal: Boolean(
      meeting.transcriptAllFinal ?? meeting.transcript_all_final,
    ),
    segments: (Array.isArray(meeting.segments) ? meeting.segments : [])
      .filter(isPlainObject)
      .map(normalizeSegment),
    summary: optionalString(meeting.summary),
    notes: String(meeting.notes || ''),
    summaryTruncated: Boolean(meeting.summaryTruncated ?? meeting.summary_truncated),
    summaryNeedsUpdate: Boolean(meeting.summaryNeedsUpdate ?? meeting.summary_needs_update),
    summaryState: String(meeting.summaryState ?? meeting.summary_state ?? 'not-started'),
    kgState: String(meeting.kgState ?? meeting.kg_state ?? 'not-offered'),
    graphNodeId: optionalString(meeting.graphNodeId ?? meeting.graph_node_id),
    graphDraft: normalizeMeetingGraphDraft(meeting.graphDraft ?? meeting.graph_draft),
    jobs: (Array.isArray(meeting.jobs) ? meeting.jobs : [])
      .filter(isPlainObject)
      .map(normalizeJob),
    error: optionalString(meeting.error),
    updatedAt: optionalString(meeting.updatedAt ?? meeting.updated_at),
  }
}

function normalizeMeetingGraphDraft(value) {
  const draft = object(value)
  return {
    projectResolved: Boolean(draft.projectResolved ?? draft.project_resolved),
    projectId: optionalString(draft.projectId ?? draft.project_id),
    peopleIds: uniqueStrings(draft.peopleIds ?? draft.people_ids),
    scopeId: optionalString(draft.scopeId ?? draft.scope_id),
  }
}

function serializeMeetingGraphDraft(value) {
  const draft = normalizeMeetingGraphDraft(value)
  return {
    projectResolved: draft.projectResolved,
    projectId: draft.projectResolved ? draft.projectId : null,
    peopleIds: draft.peopleIds,
    scopeId: draft.scopeId,
  }
}

function normalizeMeetingSearchHit(value) {
  const hit = object(value)
  const matched = object(hit.matched)
  return {
    meeting: normalizeMeeting(hit.meeting),
    matched: {
      title: Boolean(matched.title),
      summary: Boolean(matched.summary),
      tags: Boolean(matched.tags),
      transcript: (Array.isArray(matched.transcript) ? matched.transcript : [])
        .filter(isPlainObject)
        .slice(0, 3)
        .map(value => ({
          meetingId: String(value.meetingId ?? value.meeting_id ?? ''),
          segmentId: String(value.segmentId ?? value.segment_id ?? ''),
          startMs: nonnegativeInteger(value.startMs ?? value.start_ms),
          text: String(value.text || ''),
        })),
    },
  }
}

function normalizeTranscriptCursor(value) {
  const cursor = object(value)
  const segmentId = String(cursor.segmentId ?? cursor.segment_id ?? '').trim()
  if (!segmentId) throw new Error('Transcript cursor is missing its segment identifier.')
  return {
    startMs: nonnegativeInteger(cursor.startMs ?? cursor.start_ms),
    endMs: nonnegativeInteger(cursor.endMs ?? cursor.end_ms),
    segmentId,
  }
}

function normalizeMeetingLibraryCursor(value) {
  const cursor = object(value)
  const createdAt = String(cursor.createdAt ?? cursor.created_at ?? '').trim()
  const meetingId = String(cursor.meetingId ?? cursor.meeting_id ?? '').trim()
  if (!createdAt || !meetingId) throw new Error('Meeting library cursor is incomplete.')
  return { createdAt, meetingId }
}

function normalizeSegment(value) {
  const segment = object(value)
  return {
    id: String(segment.id || ''),
    text: String(segment.text || ''),
    startMs: nonnegativeInteger(segment.startMs ?? segment.start_ms),
    endMs: nonnegativeInteger(segment.endMs ?? segment.end_ms),
    channel: String(segment.channel || 'unknown'),
    speaker: optionalString(segment.speaker),
    final: segment.final !== false,
    revision: nonnegativeInteger(segment.revision),
  }
}

function normalizeJob(value) {
  const job = object(value)
  return {
    id: String(job.id || ''),
    kind: String(job.kind || ''),
    status: String(job.status || 'queued'),
    activityId: optionalString(job.activityId ?? job.activity_id),
    attempt: nonnegativeInteger(job.attempt),
    error: optionalString(job.error),
  }
}

function normalizeCandidate(value) {
  const candidate = object(value)
  return {
    id: String(candidate.id || ''),
    appId: String(candidate.appId ?? candidate.app_id ?? ''),
    appName: String(candidate.appName ?? candidate.app_name ?? 'Meeting app'),
    detectedAt: optionalString(candidate.detectedAt ?? candidate.detected_at),
    confidence: Number.isFinite(Number(candidate.confidence))
      ? Number(candidate.confidence)
      : 0,
  }
}

function normalizeMeetingRecordRequest(value) {
  const request = object(value)
  return {
    action: request.action === 'record' ? 'record' : 'open',
    candidateId: String(request.candidateId ?? request.candidate_id ?? '').trim(),
    appName: String(request.appName ?? request.app_name ?? 'Meeting app').trim() || 'Meeting app',
  }
}

function normalizeMeetingsConfig(value) {
  const config = object(value)
  const ignoredApps = config.ignoredApps ?? config.ignored_apps
  return {
    ignoredApps: (Array.isArray(ignoredApps) ? ignoredApps : []).filter(isPlainObject).map(app => ({
      appId: String(app.appId ?? app.app_id ?? ''),
      appName: String(app.appName ?? app.app_name ?? ''),
    })),
    detectionEnabled: Boolean(config.detectionEnabled ?? config.detection_enabled),
    autoRecord: Boolean(config.autoRecord ?? config.auto_record),
    microphoneDeviceId: optionalString(
      config.microphoneDeviceId ?? config.microphone_device_id,
    ),
    transcriptionMode: String(
      config.transcriptionMode ?? config.transcription_mode ?? 'local',
    ),
    customUrl: String(config.customUrl ?? config.custom_url ?? ''),
    customModel: String(config.customModel ?? config.custom_model ?? ''),
    apiKeyConfigured: Boolean(config.apiKeyConfigured ?? config.api_key_configured),
    localModel: String(config.localModel ?? config.local_model ?? 'whisper-small'),
    summaryEnabled: config.summaryEnabled ?? config.summary_enabled ?? true,
    summaryTemplate: String(config.summaryTemplate ?? config.summary_template ?? 'standard'),
    summaryPrompt: String(config.summaryPrompt ?? config.summary_prompt ?? ''),
    summaryPreset: String(config.summaryPreset ?? config.summary_preset ?? ''),
    kgPrompt: String(config.kgPrompt ?? config.kg_prompt ?? 'ask'),
    kgPreset: String(config.kgPreset ?? config.kg_preset ?? ''),
    retentionDays: nullableNonnegativeInteger(
      config.retentionDays ?? config.retention_days ?? 30,
    ),
  }
}

function normalizePermissions(value) {
  const permissions = object(value)
  return {
    microphone: String(permissions.microphone || 'unknown'),
    systemAudio: String(permissions.systemAudio ?? permissions.system_audio ?? 'unknown'),
  }
}

function normalizeModel(value) {
  const model = object(value)
  return {
    id: String(model.id || ''),
    title: String(model.title || model.id || 'Local model'),
    status: String(model.status || 'not-installed'),
    bytes: nonnegativeInteger(model.bytes),
    downloadedBytes: nonnegativeInteger(model.downloadedBytes ?? model.downloaded_bytes),
    checksum: optionalString(model.checksum),
    error: optionalString(model.error),
  }
}

function serializeConfigPatch(patch) {
  const source = object(patch)
  const serialized = {}
  if ('detectionEnabled' in source) serialized.detectionEnabled = Boolean(source.detectionEnabled)
  if ('ignoredApps' in source) {
    if (!Array.isArray(source.ignoredApps)) throw new Error('Ignored apps must be a list.')
    serialized.ignoredApps = source.ignoredApps.map(app => ({
      appId: requiredId(app?.appId, 'app'),
      appName: requiredId(app?.appName, 'app name'),
    }))
  }
  if ('autoRecord' in source) serialized.autoRecord = Boolean(source.autoRecord)
  if ('microphoneDeviceId' in source) {
    serialized.microphoneDeviceId = source.microphoneDeviceId == null
      ? null
      : requiredId(source.microphoneDeviceId, 'microphone')
  }
  if ('transcriptionMode' in source) {
    const mode = String(source.transcriptionMode || '').trim()
    if (!['local', 'custom'].includes(mode)) {
      throw new Error('Transcription mode must be local or custom.')
    }
    serialized.transcriptionMode = mode
  }
  if ('customUrl' in source) serialized.customUrl = String(source.customUrl || '').trim()
  if ('customModel' in source) serialized.customModel = String(source.customModel || '').trim()
  if ('localModel' in source) serialized.localModel = requiredId(source.localModel, 'model')
  if ('summaryEnabled' in source) serialized.summaryEnabled = Boolean(source.summaryEnabled)
  if ('summaryTemplate' in source) {
    const template = String(source.summaryTemplate || '').trim()
    if (!['standard', 'brief', 'decisions-actions', 'detailed'].includes(template)) {
      throw new Error('Choose a valid summary format.')
    }
    serialized.summaryTemplate = template
  }
  if ('summaryPrompt' in source) {
    const prompt = String(source.summaryPrompt ?? '')
    if (!prompt.trim()) throw new Error('Summary instructions cannot be empty.')
    if ([...prompt].length > 16_000) {
      throw new Error('Summary instructions cannot exceed 16000 characters.')
    }
    serialized.summaryPrompt = prompt
  }
  if ('summaryPreset' in source) serialized.summaryPreset = String(source.summaryPreset || '').trim()
  if ('kgPrompt' in source) {
    const behavior = String(source.kgPrompt || '').trim()
    if (!['ask', 'always-draft', 'never'].includes(behavior)) {
      throw new Error('Knowledge-graph follow-up must be ask, always-draft, or never.')
    }
    serialized.kgPrompt = behavior
  }
  if ('kgPreset' in source) serialized.kgPreset = String(source.kgPreset || '').trim()
  if ('retentionDays' in source) {
    serialized.retentionDays = source.retentionDays == null
      ? null
      : nullableNonnegativeInteger(source.retentionDays)
  }
  return serialized
}

function normalizeMeetingAudioTestEvent(value) {
  const event = object(value)
  const source = candidate => {
    const projection = object(candidate)
    const state = String(projection.state || 'no-data')
    return {
      state: ['open-failed', 'no-data', 'silent', 'signal', 'ended', 'stopped'].includes(state)
        ? state
        : 'no-data',
      level: Math.min(100, nonnegativeInteger(projection.level)),
      error: optionalString(projection.error),
    }
  }
  return {
    testId: String(event.testId ?? event.test_id ?? ''),
    sequence: nonnegativeInteger(event.sequence),
    state: String(event.state || 'running') === 'stopped' ? 'stopped' : 'running',
    runtimeIdentity: (event.runtimeIdentity ?? event.runtime_identity) === 'mimir'
      ? 'mimir'
      : 'development-host',
    microphone: source(event.microphone),
    systemAudio: source(event.systemAudio ?? event.system_audio),
    microphoneDeviceId: optionalString(event.microphoneDeviceId ?? event.microphone_device_id),
    microphoneDeviceName: optionalString(
      event.microphoneDeviceName ?? event.microphone_device_name,
    ),
    fallbackFromMicrophoneDeviceId: optionalString(
      event.fallbackFromMicrophoneDeviceId ?? event.fallback_from_microphone_device_id,
    ),
  }
}

function compareMeetings(left, right) {
  return String(right.startedAt || right.updatedAt || '')
    .localeCompare(String(left.startedAt || left.updatedAt || ''))
    || left.id.localeCompare(right.id)
}

function requiredId(value, label) {
  const id = String(value || '').trim()
  if (!id) throw new Error(`Choose a ${label}.`)
  return id
}

function requiredString(value, label) {
  const string = String(value || '').trim()
  if (!string) throw new Error(`${label} is missing.`)
  return string
}

function uniqueStrings(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map(candidate => String(candidate).trim())
      .filter(Boolean),
  )]
}

function normalizeMeetingTags(value) {
  if (!Array.isArray(value)) return []
  const tags = []
  const seen = new Set()
  for (const candidate of value.slice(0, MAX_MEETING_TAGS)) {
    if (typeof candidate !== 'string') continue
    const tag = candidate.trim()
    if (
      !tag
      || tag.length > MAX_MEETING_TAG_CHARS
      || utf8Bytes(tag) > MAX_MEETING_TAG_BYTES
      || hasControlCharacter(tag)
      || seen.has(tag)
    ) continue
    seen.add(tag)
    tags.push(tag)
  }
  return tags
}

function serializeMeetingTags(value) {
  if (!Array.isArray(value)) {
    throw new Error('Reviewed tags must be an array.')
  }
  if (value.length > MAX_MEETING_TAGS) {
    throw new Error(`Reviewed tags cannot contain more than ${MAX_MEETING_TAGS} entries.`)
  }
  const tags = []
  const seen = new Set()
  for (const candidate of value) {
    if (typeof candidate !== 'string') {
      throw new Error('Every reviewed tag must be text.')
    }
    const tag = candidate.trim()
    if (!tag) throw new Error('Reviewed tags cannot be empty.')
    if (tag.length > MAX_MEETING_TAG_CHARS) {
      throw new Error(
        `Reviewed tags cannot exceed ${MAX_MEETING_TAG_CHARS} characters each.`,
      )
    }
    if (utf8Bytes(tag) > MAX_MEETING_TAG_BYTES) {
      throw new Error(
        `Reviewed tags cannot exceed ${MAX_MEETING_TAG_BYTES} UTF-8 bytes each.`,
      )
    }
    if (hasControlCharacter(tag)) {
      throw new Error('Reviewed tags cannot contain control characters.')
    }
    if (seen.has(tag)) continue
    seen.add(tag)
    tags.push(tag)
  }
  return tags
}

function utf8Bytes(value) {
  return new TextEncoder().encode(value).byteLength
}

function hasControlCharacter(value) {
  return /[\u0000-\u001f\u007f]/u.test(value)
}

function optionalString(value) {
  if (value == null) return null
  const string = String(value)
  return string || null
}

function nonnegativeInteger(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0
}

function nullableNonnegativeInteger(value) {
  if (value == null || value === '') return null
  return nonnegativeInteger(value)
}

function object(value) {
  return isPlainObject(value) ? value : {}
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
