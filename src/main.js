import { createApp } from 'vue'
import { createPinia } from './stores/index.js'
import { emit as telemetryEmit } from './services/telemetry.js'
import './shared/styles/app.css'

window.addEventListener('error', () => {
  telemetryEmit('error', { category: 'runtime' })
})
window.addEventListener('unhandledrejection', () => {
  telemetryEmit('error', { category: 'promise' })
})

const params = new URLSearchParams(window.location.search)
const platform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || ''
document.documentElement.classList.toggle('platform-macos', /mac|iphone|ipad|ipod/i.test(platform))
document.documentElement.classList.toggle('chrome-calibrate', ['1', 'true'].includes(params.get('chromeCalibrate')))


if (params.get('view') === 'ghost') {
  const text = localStorage.getItem('shoulders:ghost-text') || 'Tab'
  document.body.style.cssText = 'margin:0;background:transparent;overflow:hidden'
  document.getElementById('app').innerHTML = `<div style="
    padding: 4px 12px;
    border-radius: 6px;
    background: rgba(255,255,255,0.92);
    border: 1px solid rgba(0,0,0,0.1);
    box-shadow: 0 6px 20px rgba(0,0,0,0.2), 0 2px 6px rgba(0,0,0,0.08);
    font: 500 11px/1 ui-monospace, monospace;
    white-space: nowrap;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    color: #333;
  ">${text}</div>`
} else if (params.get('view') === 'editor') {
  import('./editor/App.vue').then(m => {
    createApp(m.default).use(createPinia()).mount('#app')
  })
} else if (params.get('view') === 'panel') {
  import('./panel/styles.css')
  import('./panel/App.vue').then(m => {
    createApp(m.default).use(createPinia()).mount('#app')
  })
} else {
  import('./mim/MimPanel.vue').then(m => {
    createApp(m.default).use(createPinia()).mount('#app')
  })
}
