let _cache = null
let _cacheTime = 0
const CACHE_TTL = 10 * 60 * 1000

export default defineEventHandler(async () => {
  const now = Date.now()
  if (_cache && now - _cacheTime < CACHE_TTL) {
    return _cache
  }

  const config = useRuntimeConfig()
  const repo = config.githubRepo || 'shoulders-ai/shoulders-private'
  const token = config.githubToken

  try {
    const releaseRes = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    })
    if (!releaseRes.ok) {
      throw createError({ statusCode: 204, statusMessage: 'No update available' })
    }
    const release = await releaseRes.json()

    const latestJsonAsset = release.assets.find(a => a.name === 'latest.json')
    if (!latestJsonAsset) {
      throw createError({ statusCode: 204, statusMessage: 'No update available' })
    }

    const assetRes = await fetch(
      `https://api.github.com/repos/${repo}/releases/assets/${latestJsonAsset.id}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/octet-stream',
        },
        redirect: 'follow',
      }
    )
    if (!assetRes.ok) {
      throw createError({ statusCode: 502, statusMessage: 'Failed to fetch update info' })
    }

    const data = await assetRes.json()

    _cache = data
    _cacheTime = now
    return data
  } catch (e) {
    if (e.statusCode) throw e
    console.error('[updates] GitHub fetch error:', e.message)
    throw createError({ statusCode: 502, statusMessage: 'Failed to fetch update info' })
  }
})
