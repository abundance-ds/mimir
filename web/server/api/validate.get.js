export default defineEventHandler(async (event) => {
  const { key } = getQuery(event)

  const claims = verifyToken(key)

  if (claims.role === 'admin') {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }

  const config = useRuntimeConfig()
  const repo = config.githubRepo || 'shoulders-ai/shoulders-private'
  const token = config.githubToken

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    })
    if (!res.ok) throw new Error('GitHub API error')
    const release = await res.json()

    const assets = release.assets
      .filter(a => {
        if (claims.platforms?.includes('macos-arm') && a.name.endsWith('.dmg')) return true
        if (claims.platforms?.includes('windows') && a.name.endsWith('.msi')) return true
        if (claims.platforms?.includes('linux') && a.name.endsWith('.deb')) return true
        return false
      })
      .map(a => ({
        name: a.name,
        label: a.name.endsWith('.dmg') ? 'macOS (Apple Silicon)' : a.name.endsWith('.deb') ? 'Linux' : 'Windows',
        size: `${(a.size / 1024 / 1024).toFixed(1)} MB`,
        id: a.id,
      }))

    return {
      client: { name: claims.name },
      assets,
      version: release.tag_name,
    }
  } catch (err) {
    console.error('[validate] GitHub fetch error:', err.message)
    throw createError({ statusCode: 502, statusMessage: 'Could not fetch release info' })
  }
})
