<template>
  <div v-if="!authed" class="min-h-screen bg-neutral-950 flex items-center justify-center">
    <form @submit.prevent="login" class="w-full max-w-xs px-6">
      <h1 class="text-2xl font-serif text-white mb-6 text-center">Shoulders Admin</h1>
      <input
        v-model="key"
        type="password"
        placeholder="Access token"
        class="w-full px-3 py-2 bg-neutral-900 border border-neutral-700 rounded-md text-sm text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-neutral-500"
      />
      <button
        type="submit"
        :disabled="logging"
        class="mt-3 w-full bg-white text-neutral-900 text-sm font-medium px-3 py-2 rounded-md hover:bg-neutral-200 transition-colors disabled:opacity-50"
      >
        {{ logging ? 'Checking...' : 'Log in' }}
      </button>
      <p v-if="loginError" class="text-red-400 text-xs mt-3 text-center">{{ loginError }}</p>
    </form>
  </div>

  <div v-else class="min-h-screen bg-stone-50">
    <nav class="sticky top-0 z-40 bg-white border-b border-stone-200 h-12 flex items-center px-6">
      <span class="font-medium text-stone-900 text-sm">Shoulders Admin</span>
      <div class="flex-1 flex items-center justify-center gap-6">
        <NuxtLink
          v-for="link in navLinks"
          :key="link.to"
          :to="link.to"
          class="text-sm transition-colors"
          :class="isActive(link.to) ? 'text-stone-900 font-medium' : 'text-stone-400 hover:text-stone-600'"
        >
          {{ link.label }}
        </NuxtLink>
      </div>
      <button
        @click="logout"
        class="text-sm text-stone-400 hover:text-stone-600 transition-colors"
      >
        Logout
      </button>
    </nav>
    <div class="max-w-6xl mx-auto px-6 py-8">
      <NuxtPage />
    </div>
  </div>
</template>

<script setup>
const route = useRoute()
const router = useRouter()

const authed = ref(false)
const key = ref('')
const logging = ref(false)
const loginError = ref('')

const isDev = import.meta.dev
const navLinks = [
  { to: '/admin', label: 'Dashboard' },
  { to: '/admin/clients', label: 'Clients' },
  ...(isDev ? [{ to: '/admin/profiles', label: 'Profiles' }] : []),
  { to: '/admin/telemetry', label: 'Telemetry' },
  { to: '/admin/analytics', label: 'Website' },
]

function isActive(to) {
  if (to === '/admin') return route.path === '/admin'
  return route.path.startsWith(to)
}

async function login() {
  logging.value = true
  loginError.value = ''
  try {
    const res = await $fetch('/api/admin/login', {
      method: 'POST',
      body: { key: key.value },
    })
    if (res?.ok) {
      authed.value = true
    } else {
      loginError.value = 'Invalid key'
    }
  } catch {
    loginError.value = 'Invalid key'
  } finally {
    logging.value = false
  }
}

async function logout() {
  await $fetch('/api/admin/logout', { method: 'POST' }).catch(() => {})
  authed.value = false
  key.value = ''
}

onMounted(async () => {
  try {
    await $fetch('/api/admin/stats')
    authed.value = true
  } catch {
    authed.value = false
  }
})
</script>
