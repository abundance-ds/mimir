export default defineEventHandler(async (event) => {
  const { key, asset } = getQuery(event)

  if (!key || typeof key !== 'string') {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }

  const validateRes = await $fetch('/api/validate', { query: { key } }).catch(() => null)
  if (!validateRes) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }

  const assetInfo = validateRes.assets.find(a => a.name === asset)
  if (!assetInfo) {
    throw createError({ statusCode: 404, statusMessage: 'Asset not found' })
  }

  const config = useRuntimeConfig()
  const repo = config.githubRepo || 'shoulders-ai/shoulders-private'
  const token = config.githubToken

  const res = await fetch(
    `https://api.github.com/repos/${repo}/releases/assets/${assetInfo.id}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/octet-stream',
      },
      redirect: 'follow',
    }
  )

  if (!res.ok) {
    throw createError({ statusCode: 502, statusMessage: 'Download failed' })
  }

  setResponseHeaders(event, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${asset}"`,
  })

  return sendStream(event, res.body)
})
