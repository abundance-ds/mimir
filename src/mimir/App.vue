<template>
  <WorkbenchApp />
  <UpdateToast />
</template>

<script setup>
import { onMounted } from 'vue'
import WorkbenchApp from './WorkbenchApp.vue'
import UpdateToast from '../shared/ui/UpdateToast.vue'
import { useAppUpdateStore } from '../stores/appUpdate.js'

const updates = useAppUpdateStore()

onMounted(() => {
  updates.startAutomaticCheck()
})
</script>
