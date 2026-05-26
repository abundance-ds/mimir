export function computeLineDelta(originalText, modifiedText) {
  const rawA = originalText || ''
  const rawB = modifiedText || ''
  const a = rawA ? rawA.split('\n') : []
  const b = rawB ? rawB.split('\n') : []
  const m = a.length, n = b.length
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  const common = dp[m][n]
  return { added: n - common, removed: m - common }
}

export function disambiguateFilenames(paths) {
  if (!paths || paths.length === 0) return []

  const basenames = paths.map(p => {
    const parts = p.split('/')
    return parts[parts.length - 1]
  })

  const baseCount = new Map()
  for (const b of basenames) {
    baseCount.set(b, (baseCount.get(b) || 0) + 1)
  }

  return paths.map((p, i) => {
    if (baseCount.get(basenames[i]) === 1) return basenames[i]

    const parts = p.split('/')
    const duplicates = paths
      .map((other, j) => ({ other, j }))
      .filter(({ j }) => j !== i && basenames[j] === basenames[i])
      .map(({ other }) => other)

    for (let depth = 2; depth <= parts.length; depth++) {
      const suffix = parts.slice(-depth).join('/')
      const isUnique = duplicates.every(other => {
        const otherParts = other.split('/')
        return otherParts.slice(-depth).join('/') !== suffix
      })
      if (isUnique) return suffix
    }

    return p
  })
}
