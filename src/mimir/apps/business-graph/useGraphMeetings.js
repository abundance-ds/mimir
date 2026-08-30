import { computed, ref } from 'vue'
import { fileMeetingToGraph } from '../../../services/meetings.js'
import { graphErrorMessage } from './graphErrors.js'

export function useGraphMeetings({ graph, meetings, diagnostic }) {
  const filingMeetingId = ref('')
  const filingError = ref('')
  const pendingMeetings = computed(() => meetings.meetings.filter(meeting => (
    meeting.lifecycle === 'ready'
    && Boolean(meeting.summary)
    && !meeting.graphNodeId
  )))

  async function fileMeeting(request) {
    if (filingMeetingId.value) return
    filingMeetingId.value = request.meetingId
    filingError.value = ''
    try {
      await meetings.flushMeetingDraft(request.meetingId)
      await fileMeetingToGraph(request)
      await Promise.all([
        meetings.refresh(),
        graph.refresh({ quiet: true }),
      ])
    } catch (cause) {
      report(cause)
    } finally {
      filingMeetingId.value = ''
    }
  }

  async function saveMeetingGraphDraft({ meetingId, graphDraft }) {
    meetings.stageMeetingPatch(meetingId, { graphDraft })
    try {
      await meetings.flushMeetingDraft(meetingId)
    } catch (cause) {
      report(cause)
    }
  }

  async function loadMeetingDetail(id) {
    try {
      await meetings.hydrateMeeting(id)
    } catch (cause) {
      report(cause)
    }
  }

  async function loadOlderMeetings() {
    try {
      await meetings.loadOlderMeetings()
    } catch (cause) {
      diagnostic(graphErrorMessage(cause))
    }
  }

  function report(cause) {
    filingError.value = graphErrorMessage(cause)
    diagnostic(filingError.value)
  }

  return {
    fileMeeting,
    filingError,
    filingMeetingId,
    loadMeetingDetail,
    loadOlderMeetings,
    pendingMeetings,
    saveMeetingGraphDraft,
  }
}
