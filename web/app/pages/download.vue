<template>
  <div class="min-h-screen bg-neutral-50 flex items-center justify-center">
    <div class="max-w-lg w-full px-6">
      <div v-if="error" class="text-center">
        <h1 class="text-2xl font-serif text-neutral-900 mb-2">Access denied</h1>
        <p class="text-neutral-500 text-sm">This link is not valid or has expired.</p>
      </div>
      <div v-else-if="client" class="text-center">
        <h1 class="text-2xl font-serif text-neutral-900 mb-1">Shoulders</h1>
        <p class="text-neutral-500 text-sm mb-8">Welcome, {{ client.name }}</p>

        <div class="space-y-3">
          <a v-for="asset in assets" :key="asset.name"
             :href="`/api/download?key=${key}&asset=${asset.name}`"
             @click="onDownloadClick(asset)"
             class="block px-5 py-3 bg-white border border-neutral-200 rounded-lg hover:bg-neutral-100 transition-colors text-sm text-neutral-800">
            {{ asset.label }}
            <span class="text-neutral-400 text-xs ml-2">{{ asset.size }}</span>
          </a>
        </div>

        <p class="text-neutral-400 text-xs mt-8">v{{ version }}</p>
      </div>
      <div v-else class="text-center">
        <p class="text-neutral-400">Loading...</p>
      </div>
    </div>
  </div>
</template>

<script setup>
const route = useRoute()
const key = route.query.key || ''
const { $trackDownload } = useNuxtApp()

const { data: downloadInfo, error } = await useFetch('/api/validate', {
  query: { key },
})

const client = computed(() => downloadInfo.value?.client)
const assets = computed(() => downloadInfo.value?.assets || [])
const version = computed(() => downloadInfo.value?.version || '?')

function derivePlatform(assetName) {
  const n = (assetName || '').toLowerCase()
  if (n.includes('mac') || n.includes('darwin') || n.includes('dmg')) return 'macos'
  if (n.includes('arm')) return n.includes('mac') || n.includes('darwin') ? 'macos-arm' : 'linux-arm'
  if (n.includes('win') || n.includes('.exe') || n.includes('.msi')) return 'windows'
  if (n.includes('linux') || n.includes('.deb') || n.includes('.appimage')) return 'linux'
  return 'unknown'
}

function onDownloadClick(asset) {
  if ($trackDownload) {
    $trackDownload(derivePlatform(asset.name))
  }
}
</script>
