<template>
  <div>
    <div class="mb-8">
      <h1 class="text-2xl font-serif font-semibold tracking-tight text-stone-900">Clients</h1>
      <p class="text-sm text-stone-500 mt-1">Manage download access for design partners.</p>
    </div>

    <div v-if="pending" class="text-sm text-stone-400">Loading...</div>
    <div v-else-if="error" class="text-sm text-red-600">Failed to load clients.</div>
    <template v-else>
      <!-- Signing key warning -->
      <div v-if="!canSign" class="bg-white rounded-lg border border-stone-200 p-4 mb-6">
        <p class="text-sm text-stone-600">
          Signing key not configured. Add <code class="text-xs font-mono bg-stone-100 px-1.5 py-0.5 rounded">NUXT_PORTAL_SIGNING_KEY</code> to .env to enable token issuance.
        </p>
      </div>

      <!-- Client table -->
      <div v-if="clients.length" class="bg-white rounded-lg border border-stone-200 overflow-hidden mb-6">
        <table class="w-full">
          <thead>
            <tr class="border-b border-stone-100">
              <th class="text-left text-xs font-medium text-stone-500 uppercase px-4 py-2">Name</th>
              <th class="text-left text-xs font-medium text-stone-500 uppercase px-4 py-2">Platforms</th>
              <th class="text-left text-xs font-medium text-stone-500 uppercase px-4 py-2">Issued</th>
              <th class="text-left text-xs font-medium text-stone-500 uppercase px-4 py-2">Expires</th>
              <th class="text-right text-xs font-medium text-stone-500 uppercase px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="c in clients"
              :key="c.jti"
              class="border-b border-stone-50"
            >
              <td class="px-4 py-2.5">
                <div class="flex items-center gap-2">
                  <span
                    class="w-1.5 h-1.5 rounded-full flex-shrink-0"
                    :class="statusDotColor(c.status)"
                  ></span>
                  <span
                    class="text-sm"
                    :class="c.status === 'active' ? 'text-stone-900' : 'text-stone-400'"
                  >{{ c.name }}</span>
                </div>
              </td>
              <td class="px-4 py-2.5 text-sm text-stone-600">{{ formatPlatforms(c.platforms) }}</td>
              <td class="px-4 py-2.5 text-sm text-stone-600">{{ formatDate(c.issuedAt) }}</td>
              <td class="px-4 py-2.5 text-sm text-stone-600">{{ formatDate(c.expiresAt) }}</td>
              <td class="px-4 py-2.5 text-right">
                <div class="flex items-center justify-end gap-2">
                  <button
                    v-if="c.token"
                    @click="copyUrl(c.token, c.jti)"
                    class="text-xs px-2.5 py-1 rounded border border-stone-200 hover:bg-stone-100 transition-colors"
                  >{{ copiedJti === c.jti ? 'Copied' : 'Copy URL' }}</button>
                  <button
                    v-if="c.status === 'active'"
                    @click="revoke(c.jti)"
                    :disabled="revoking === c.jti"
                    class="text-xs px-2.5 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
                  >{{ revoking === c.jti ? 'Revoking...' : 'Revoke' }}</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Empty state -->
      <div v-else class="bg-white rounded-lg border border-stone-200 p-8 text-center mb-6">
        <p class="text-sm text-stone-500 mb-4">No clients yet.</p>
        <button
          v-if="canSign"
          @click="showForm = true"
          class="bg-stone-900 hover:bg-stone-800 text-white font-medium text-sm px-5 py-2 rounded tracking-wide transition-colors"
        >Issue Token</button>
      </div>

      <!-- Toggle form button -->
      <div v-if="canSign && clients.length" class="mb-6">
        <button
          @click="showForm = !showForm"
          class="text-sm text-stone-600 hover:text-stone-900 transition-colors"
        >{{ showForm ? 'Cancel' : '+ Issue token' }}</button>
      </div>

      <!-- Issue token form -->
      <div v-if="showForm && canSign" class="bg-white rounded-lg border border-stone-200 p-4 mb-6">
        <div class="text-sm font-medium text-stone-700 mb-4">Issue Token</div>

        <div class="space-y-4 max-w-md">
          <div>
            <label class="text-xs text-stone-500 uppercase tracking-wide block mb-1">Name</label>
            <input
              v-model="form.name"
              type="text"
              placeholder="e.g. Acme Pharma"
              class="text-xs border border-stone-200 rounded-md px-2 py-1 bg-white text-stone-700 w-full focus:outline-none focus:border-stone-400"
            />
          </div>

          <div>
            <label class="text-xs text-stone-500 uppercase tracking-wide block mb-1">Platforms</label>
            <div class="flex items-center gap-4">
              <label class="flex items-center gap-1.5 text-sm text-stone-700">
                <input type="checkbox" v-model="form.macosArm" class="rounded border-stone-300" />
                macOS ARM
              </label>
              <label class="flex items-center gap-1.5 text-sm text-stone-700">
                <input type="checkbox" v-model="form.windows" class="rounded border-stone-300" />
                Windows
              </label>
              <label class="flex items-center gap-1.5 text-sm text-stone-700">
                <input type="checkbox" v-model="form.linux" class="rounded border-stone-300" />
                Linux
              </label>
            </div>
          </div>

          <div>
            <label class="text-xs text-stone-500 uppercase tracking-wide block mb-1">Expires in</label>
            <select
              v-model="form.expiresIn"
              class="text-xs border border-stone-200 rounded-md px-2 py-1 bg-white text-stone-700 focus:outline-none focus:border-stone-400"
            >
              <option value="365d">365 days</option>
              <option value="180d">180 days</option>
              <option value="90d">90 days</option>
              <option value="30d">30 days</option>
              <option value="7d">7 days</option>
            </select>
          </div>

          <button
            @click="issueToken"
            :disabled="issuing || !form.name.trim() || !selectedPlatforms.length"
            class="bg-stone-900 hover:bg-stone-800 text-white font-medium text-sm px-5 py-2 rounded tracking-wide transition-colors disabled:opacity-50"
          >{{ issuing ? 'Issuing...' : 'Issue' }}</button>

          <div v-if="issueError" class="text-sm text-red-600">{{ issueError }}</div>
        </div>

        <!-- Success result -->
        <div v-if="issueResult" class="mt-4 bg-stone-50 rounded-lg border border-stone-200 p-4">
          <div class="text-sm font-medium text-stone-700 mb-2">Token issued for {{ issueResult.name }}</div>
          <div class="text-xs font-mono text-stone-600 break-all mb-3">{{ issueResult.url }}</div>
          <button
            @click="copyIssueUrl"
            class="text-xs px-2.5 py-1 rounded border border-stone-200 hover:bg-stone-100 transition-colors"
          >{{ issueUrlCopied ? 'Copied' : 'Copy URL' }}</button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
const { data, pending, error, refresh } = await useFetch('/api/admin/clients')

const canSign = computed(() => data.value?.canSign ?? false)
const clients = computed(() => data.value?.clients ?? [])

const showForm = ref(false)
const issuing = ref(false)
const issueError = ref('')
const issueResult = ref(null)
const issueUrlCopied = ref(false)
const revoking = ref(null)
const copiedJti = ref(null)

const form = reactive({
  name: '',
  macosArm: true,
  windows: true,
  linux: false,
  expiresIn: '365d',
})

const selectedPlatforms = computed(() => {
  const p = []
  if (form.macosArm) p.push('macos-arm')
  if (form.windows) p.push('windows')
  if (form.linux) p.push('linux')
  return p
})

const platformLabels = { 'macos-arm': 'macOS', windows: 'Windows', linux: 'Linux' }

function formatPlatforms(platforms) {
  if (!platforms?.length) return ''
  return platforms.map(p => platformLabels[p] || p).join(', ')
}

function formatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function statusDotColor(status) {
  if (status === 'active') return 'bg-emerald-500'
  if (status === 'revoked') return 'bg-red-500'
  return 'bg-stone-300'
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
}

function tokenUrl(token) {
  return `https://v3.shoulde.rs/download?key=${token}`
}

async function copyUrl(token, jti) {
  await copyToClipboard(tokenUrl(token))
  copiedJti.value = jti
  setTimeout(() => {
    if (copiedJti.value === jti) copiedJti.value = null
  }, 1500)
}

async function copyIssueUrl() {
  if (!issueResult.value) return
  await copyToClipboard(issueResult.value.url)
  issueUrlCopied.value = true
  setTimeout(() => { issueUrlCopied.value = false }, 1500)
}

async function issueToken() {
  issuing.value = true
  issueError.value = ''
  issueResult.value = null
  try {
    const res = await $fetch('/api/admin/clients', {
      method: 'POST',
      body: {
        name: form.name.trim(),
        platforms: selectedPlatforms.value,
        expiresIn: form.expiresIn,
      },
    })
    issueResult.value = {
      name: form.name.trim(),
      url: tokenUrl(res.jti),
    }
    // Preserve the URL from the response if provided
    if (res.url) issueResult.value.url = res.url
    form.name = ''
    form.macosArm = true
    form.windows = true
    form.linux = false
    form.expiresIn = '365d'
    await refresh()
  } catch (e) {
    issueError.value = e?.data?.message || 'Failed to issue token.'
  } finally {
    issuing.value = false
  }
}

async function revoke(jti) {
  revoking.value = jti
  try {
    await $fetch('/api/admin/revoke', {
      method: 'POST',
      body: { jti },
    })
    await refresh()
  } catch {
    // silently fail, row will remain active
  } finally {
    revoking.value = null
  }
}
</script>
