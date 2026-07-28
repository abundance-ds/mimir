import { computed } from 'vue'
import { normalizePath, normalizeRelative } from './filePaths.js'

export function useFileFavorites({ settings, workspacePath }) {
  const workspaceKey = computed(() => normalizePath(workspacePath.value))
  const favorites = computed(() => {
    const value = settings.workbenchFileFavorites?.[workspaceKey.value]
    return Array.isArray(value) ? value : []
  })

  function setFavorites(next) {
    settings.set('workbenchFileFavorites', {
      ...(settings.workbenchFileFavorites || {}),
      [workspaceKey.value]: next,
    })
  }

  function toggleFavorite(entry) {
    if (!entry || entry.missing) return
    const relativePath = normalizeRelative(entry.relativePath)
    const next = [...favorites.value]
    const index = next.findIndex(
      record => normalizeRelative(record.relativePath) === relativePath,
    )
    if (index >= 0) next.splice(index, 1)
    else next.push({ relativePath, isDirectory: Boolean(entry.isDirectory) })
    setFavorites(next)
  }

  function isFavorite(entry) {
    const relativePath = normalizeRelative(entry?.relativePath)
    return Boolean(relativePath) && favorites.value.some(
      record => normalizeRelative(record.relativePath) === relativePath,
    )
  }

  function updateFavoritePaths(oldRelativePath, newRelativePath) {
    const oldPath = normalizeRelative(oldRelativePath)
    const newPath = normalizeRelative(newRelativePath)
    const next = favorites.value.map((record) => {
      const path = normalizeRelative(record.relativePath)
      if (path === oldPath) return { ...record, relativePath: newPath }
      if (path.startsWith(`${oldPath}/`)) {
        return { ...record, relativePath: `${newPath}${path.slice(oldPath.length)}` }
      }
      return record
    })
    setFavorites(next)
  }

  return {
    favorites,
    isFavorite,
    toggleFavorite,
    updateFavoritePaths,
  }
}
