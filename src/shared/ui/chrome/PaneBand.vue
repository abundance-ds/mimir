<template><component :is="as" :class="kind === 'header' ? 'pane-header' : 'pane-footer'"><slot /></component></template>
<script setup>
defineProps({ kind: { type: String, default: 'header', validator: value => ['header', 'footer'].includes(value) }, as: { type: String, default: 'div' } })
</script>
