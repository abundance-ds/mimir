export async function completeNativeQuit({
  requestClose,
  flushSettings,
  confirmQuit,
}) {
  const guarded = await requestClose({
    closeNative: false,
    revealBeforeConfirm: true,
  })
  if (!guarded) return false

  const settingsSaved = await flushSettings()
  if (settingsSaved === false) return false

  await confirmQuit()
  return true
}
