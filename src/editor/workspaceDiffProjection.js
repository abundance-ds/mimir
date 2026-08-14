export function singleDiffTargetsFile(diff, file) {
  if (!file) return false
  if (diff?.fileId != null) return file.id === diff.fileId
  if (diff?.filePath) return file.path === diff.filePath
  return !file.path
}

export function diffIsVisibleForFile(diff, file, pathIsVisible = () => true) {
  if (!diff?.active) return false
  if (!diff.isBatch) {
    return singleDiffTargetsFile(diff, file)
      && (!diff.filePath || pathIsVisible(diff.filePath))
  }

  const paths = (diff.files || []).map(candidate => candidate.path).filter(Boolean)
  return paths.length === 0 || paths.some(pathIsVisible)
}
