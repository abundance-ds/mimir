export default defineNuxtConfig({
  compatibilityDate: '2025-05-20',
  modules: ['@nuxtjs/tailwindcss'],
  devtools: { enabled: false },
  runtimeConfig: {
    githubRepo: 'shoulders-ai/shoulders-private',
    githubToken: '',
    portalSigningKey: '',
  },
})
