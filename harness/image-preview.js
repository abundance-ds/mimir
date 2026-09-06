import { createApp, h, reactive, ref } from 'vue'
import { imageMimeType } from '../src/shared/utils/filePreview.js'
import FilePreviewPage from '../src/editor/components/workspace/FilePreviewPage.vue'
import '../src/shared/styles/app.css'

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get('theme') || 'studio'
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
<rect x="80" y="80" width="1040" height="640" rx="16" fill="#305d69"/>
<circle cx="900" cy="300" r="120" fill="#eac77b"/>
<path d="M160 620 420 270 630 530 740 420 1040 620Z" fill="#a3c2b0"/>
<text x="160" y="180" font-size="38" font-family="sans-serif" fill="white">Image preview</text></svg>`
const file = reactive({ id: 1, path: '/sample/landscape.svg', kind: 'text', content: svg, previewRevision: 0 })
const sourceMode = ref(false)
let rasterBytes
const rasterType = params.get('type')
if (['png', 'jpg', 'jpeg', 'webp'].includes(rasterType)) {
  const image = new Image()
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  image.src = url
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = 1200
  canvas.height = 800
  canvas.getContext('2d').drawImage(image, 0, 0)
  rasterBytes = new Uint8Array(await (await new Promise(resolve => canvas.toBlob(resolve, imageMimeType(`sample.${rasterType}`)))).arrayBuffer())
  URL.revokeObjectURL(url)
  file.path = `/sample/landscape.${rasterType}`
  file.kind = 'external'
  file.content = ''
}
if (rasterType === 'gif') {
  rasterBytes = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), char => char.charCodeAt(0))
  file.path = '/sample/pixel.gif'
  file.kind = 'external'
  file.content = ''
}

window.__TAURI_INTERNALS__ = {
  invoke: async command => {
    if (command === 'read_binary_file') return rasterBytes
    if (command === 'open_preview_in_default_app') return
    throw new Error(`Unexpected harness command: ${command}`)
  },
}
window.previewFile = file
createApp({
  setup() {
    return () => h('main', { class: 'flex h-full min-h-0 flex-col' }, [
      h(FilePreviewPage, {
        file, sourceMode: sourceMode.value,
        onRefresh: () => { file.previewRevision++ },
        onSourceMode: value => { sourceMode.value = value },
        onViewChange: view => { file.previewView = view },
      }),
      sourceMode.value ? h('textarea', {
        class: 'min-h-0 flex-1 bg-surface p-6 font-mono text-ink outline-none',
        value: file.content, 'aria-label': 'SVG source',
        onInput: event => { file.content = event.target.value },
      }) : null,
    ])
  },
}).mount('#app')
