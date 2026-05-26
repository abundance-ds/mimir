<template>
  <div>
    <div class="mb-8">
      <h1 class="text-2xl font-serif font-semibold tracking-tight text-stone-900">Build Profiles</h1>
      <p class="text-sm text-stone-500 mt-1">Each profile defines which skills and apps are bundled into a client build.</p>
    </div>

    <div v-if="pending" class="text-sm text-stone-400">Loading...</div>
    <div v-else-if="error" class="text-sm text-red-600">Failed to load profiles.</div>
    <template v-else>
      <!-- Profile list -->
      <div v-if="profiles.length" class="bg-white rounded-lg border border-stone-200 overflow-hidden mb-8">
        <div
          v-for="(p, i) in profiles"
          :key="p.filename"
          class="px-4 py-3 flex items-start justify-between gap-4"
          :class="i > 0 ? 'border-t border-stone-100' : ''"
        >
          <div class="min-w-0">
            <div class="text-sm font-semibold text-stone-900">{{ p.name || p.filename }}</div>
            <div class="mt-1 space-y-0.5">
              <div v-if="p.skills?.length" class="text-xs text-stone-500">
                Skills: {{ p.skills.join(', ') }}
              </div>
              <div v-if="p.apps?.length" class="text-xs text-stone-500">
                Apps: {{ p.apps.join(', ') }}
              </div>
              <div v-if="p.bundleSkills?.length" class="text-xs text-stone-500">
                Bundle skills: {{ p.bundleSkills.join(', ') }}
              </div>
            </div>
          </div>
          <a
            :href="buildUrl"
            target="_blank"
            rel="noopener"
            class="text-xs px-2.5 py-1 rounded border border-stone-200 hover:bg-stone-100 transition-colors flex-shrink-0 whitespace-nowrap"
          >Build</a>
        </div>
      </div>

      <!-- Empty state -->
      <div v-else class="bg-white rounded-lg border border-stone-200 p-8 text-center mb-8">
        <p class="text-sm text-stone-500">No profiles found in profiles/.</p>
      </div>

      <!-- Help card -->
      <div class="bg-white rounded-lg border border-stone-200 p-4">
        <div class="text-sm font-medium text-stone-700 mb-3">How to create a profile</div>
        <ol class="text-sm text-stone-600 list-decimal pl-5 space-y-1">
          <li>Create profiles/client-name.json</li>
          <li>Add custom skills to profiles/skills/</li>
          <li>Push to the repo</li>
          <li>Trigger a build from the profile card above</li>
        </ol>
      </div>
    </template>
  </div>
</template>

<script setup>
const buildUrl = 'https://github.com/shoulders-ai/shoulders-private/actions/workflows/build.yml'

const { data, pending, error } = await useFetch('/api/admin/profiles')

const profiles = computed(() => data.value ?? [])
</script>
