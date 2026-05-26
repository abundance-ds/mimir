<template>
  <svg xmlns="http://www.w3.org/2000/svg" :width="size" :height="size" viewBox="0 0 2048 2048" fill="currentColor">
    <path d="M0 0h2048v2048H0z" fill="none" />
    <path d="M2048 0v1792h-128V128H256V0zM128 256h1664v1664H128zm128 1536h1408V384H256zm256-768h896v128H512z" />
  </svg>
</template>
<script setup>
defineProps({ size: { type: Number, default: 14 } })
</script>
