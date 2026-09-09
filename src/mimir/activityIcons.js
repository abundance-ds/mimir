import {
  IconApps,
  IconPencil,
  IconFileStack,
  IconFocus2,
  IconMathPi,
  IconMessages,
  IconMicrophone,
  IconRobot,
  IconTerminal2,
  IconTopologyStar3,
  IconClockPlay,
  IconTimeline,
} from '@tabler/icons-vue'
import IconProviderAnthropic from '../shared/icons/IconProviderAnthropic.vue'
import IconProviderGoogle from '../shared/icons/IconProviderGoogle.vue'
import IconProviderOpenAI from '../shared/icons/IconProviderOpenAI.vue'
const icons = {
  scratchpad: IconPencil,
  files: IconFileStack,
  agent: IconRobot,
  codex: IconProviderOpenAI,
  claude: IconProviderAnthropic,
  pi: IconMathPi,
  gemini: IconProviderGoogle,
  terminal: IconTerminal2,
  apps: IconApps,
  today: IconFocus2,
  graph: IconTopologyStar3,
  scribe: IconMicrophone,
  tracker: IconTimeline,
  routines: IconClockPlay,
  chats: IconMessages,
}
export function iconFor(name) {
  return icons[name] || IconApps
}
export function activityIcon(activity) {
  const app = {
    scratch: 'today',
    'business-graph': 'graph',
    scribe: 'scribe',
    tracker: 'tracker',
  }[activity.source?.appId]
  if (app) return iconFor(app)
  if (['files', 'routines', 'chats'].includes(activity.id))
    return iconFor(activity.id)
  const source = String(
    activity.source?.presetId || activity.source?.launcherId || '',
  ).toLowerCase()
  for (const name of ['codex', 'claude', 'gemini'])
    if (source.includes(name)) return iconFor(name)
  if (source === 'pi' || source.includes('pi-')) return iconFor('pi')
  return iconFor(activity.kind)
}
