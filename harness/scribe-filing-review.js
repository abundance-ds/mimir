import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import '../src/shared/styles/app.css'
import ScribeApp from '../src/mimir/apps/ScribeApp.vue'
import { useMeetingsStore } from '../src/stores/meetings.js'
import { summaryHash } from '../src/services/filedMeeting.js'
const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get('theme') || 'parchment'
let meeting = {
 id: 'm1', title: 'Planning the autumn release', lifecycle: 'ready', transcription: 'final',
 startedAt: '2026-09-11T10:00:00.000Z', stoppedAt:'2026-09-11T10:45:00.000Z', durationMs:2700000,
 workspacePath:'/work', channels:['microphone','system'], gaps:[], gapCount:0,
 transcriptRevision:1, transcriptFinal:true, segmentCount:1, segments:[], summaryState:'succeeded',
 summary:'# Release plan\n\nShip the reviewed release on Friday.\n\n## Actions\n\n- Ana will complete the review.\n- Max will prepare the release notes.',
 notes:'## Agenda\n\n- Review the release plan.',
 graphDraft:{projectResolved:true, projectId:'project-alpha',peopleIds:['person-ana','person-max'],scopeId:'team:main'},
 jobs:[],tags:[],updatedAt:'2026-09-11T10:45:00.000Z',
}
let graphNode = {
 id: 'graph-m1', kind:'meeting', title:meeting.title, body:meeting.summary,
 properties:{sourceMeetingId:meeting.id,sourceSummaryHash:await summaryHash(meeting.summary)},
 relations:[{relation:'part_of',target:'project-alpha'},{relation:'attended_by',target:'person-ana'},{relation:'attended_by',target:'person-max'}],
 provenance:{scopeId:'team:main',sourceRevision:'rev1'},
}
if (params.has('filed')) meeting.graphNodeId = graphNode.id
if (params.has('draft')) meeting.summary = '# Updated release plan\n\nShip the release on Monday after one more review.\n\n- Ana will check the new transcript.'
const snapshot = () => ({
 revision:1,meetings:[structuredClone(meeting)],activeMeetingId:null,activeMeeting:null,candidates:[],
 permissions:{microphone:'granted',systemAudio:'granted'},models:[{id:'whisper-small',title:'Whisper Small',status:'installed'}],
 config:{transcriptionMode:'local',localModel:'whisper-small',summaryEnabled:true,summaryTemplate:'standard',summaryPreset:'',kgPreset:'',kgPrompt:'ask',retentionDays:30},
})
window.__TAURI_INTERNALS__ = {
 transformCallback:() => 0, unregisterCallback(){},
 invoke: async (cmd,args) => {
  switch(cmd) {
   case 'plugin:event|listen': return 1
   case 'plugin:event|unlisten': return null
   case 'meetings_snapshot': return snapshot()
   case 'meetings_transcript_page': return {meetingId:'m1',revision:1,totalSegments:1,hasMore:false,nextBefore:null,summary:meeting.summary,segments:[{id:'s1',text:'We agreed on the next release.',startMs:0,endMs:2000,channel:'microphone',final:true,revision:1}]}
   case 'meetings_update': Object.assign(meeting,args.patch);return snapshot()
   case 'meetings_file_to_graph': meeting.graphNodeId=graphNode.id;return structuredClone(graphNode)
   case 'graph_get': return structuredClone(graphNode)
   case 'graph_update': graphNode={...graphNode,...('body' in args.patch?{body:args.patch.body}:{}),properties:{...graphNode.properties,...args.patch.setProperties},provenance:{...graphNode.provenance,sourceRevision:'rev2'}};return structuredClone(graphNode)
   case 'graph_open': return {scopes:[{id:'team:main',kind:'team',root:'/team'}]}
   case 'graph_query': return {items:[{id:'project-alpha',kind:'project',title:'Autumn release'},{id:'person-ana',kind:'person',title:'Ana'},{id:'person-max',kind:'person',title:'Max'}]}
   case 'workspace_config_load': return null
   default:return null
  }
 },
}
const app=createApp({render:()=>h(ScribeApp,{active:true,workspacePath:'/work'})})
app.use(createPinia())
app.mount('#app')
window.scribe=useMeetingsStore()
