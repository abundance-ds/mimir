import { createApp } from 'vue'
import { createPinia } from './stores/index.js'
import './shared/styles/app.css'

const params = new URLSearchParams(window.location.search)
const platform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || ''
document.documentElement.classList.toggle('platform-macos', /mac|iphone|ipad|ipod/i.test(platform))
document.documentElement.classList.toggle('chrome-calibrate', ['1', 'true'].includes(params.get('chromeCalibrate')))


if (params.get('view') === 'editor') {
  import('./editor/App.vue').then(m => {
    createApp(m.default).use(createPinia()).mount('#app')
  })
} else {
  import('./mim/App.vue').then(m => {
    createApp(m.default).use(createPinia()).mount('#app')
  })
}
