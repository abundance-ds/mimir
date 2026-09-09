<template><button type="button" role="tab" class="pane-tab-select" :aria-selected="selected" :tabindex="selected ? 0 : -1"><slot /></button></template>
<script setup>
defineProps({ selected: Boolean })
</script>
<style>
.pane-tab-select {
  display: flex;
  align-items: center;
  gap: 4px;
  width: calc(100% - 28px);
  height: 100%;
  min-width: 0;
  padding: 0 0 0 8px;
  text-align: left;
  overflow: hidden;
  white-space: nowrap;
  user-select: none;
}


</style>
