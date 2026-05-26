/**
 * Rubber-band streaming text reveal.
 *
 * Ported from v0.2.x ChatMessage.vue streaming word-reveal.
 * Characters arrive in chunks from the stream. Instead of rendering all at once,
 * reveal N characters per frame with acceleration proportional to buffer size.
 *
 * Base rate: 3 chars/frame (~180 cps at 60fps) — smooths inter-token gaps
 * Acceleration: 0.08 per buffered char — steady-state about 8 words behind at 400 cps
 * Drain acceleration: 0.25 after streaming ends — resolves remaining buffer in ~150ms
 */

import { ref, watch, onUnmounted } from 'vue'

const REVEAL_BASE = 3       // chars/frame when caught up
const REVEAL_ACCEL = 0.08   // acceleration per buffered char during streaming
const DRAIN_ACCEL = 0.25    // faster drain after streaming ends

/**
 * @param {() => string} getFullText - getter for the current full text (reactive)
 * @param {() => boolean} getIsStreaming - getter for whether the stream is active
 * @returns {{ revealedLength: import('vue').Ref<number>, isRevealing: import('vue').Ref<boolean> }}
 */
export function useStreamReveal(getFullText, getIsStreaming) {
  const revealedLength = ref(Infinity)
  const isRevealing = ref(false)
  let rafId = null
  let draining = false

  function tick() {
    const fullText = getFullText()
    if (!fullText) {
      stop()
      return
    }

    const streaming = getIsStreaming()
    const fullLen = fullText.length
    const current = revealedLength.value

    // If not streaming and not draining, we are done
    if (!streaming && !draining) {
      stop()
      return
    }

    // Fully caught up
    if (current >= fullLen) {
      if (draining) {
        stop()
        return
      }
      rafId = requestAnimationFrame(tick)
      return
    }

    // Rubber-band: rate scales with buffer size
    const buffer = fullLen - current
    const accel = draining ? DRAIN_ACCEL : REVEAL_ACCEL
    const rate = Math.max(1, Math.round(REVEAL_BASE + buffer * accel))
    let target = current + rate

    // Snap to word boundary (don't cut mid-word)
    if (target < fullLen) {
      while (target < fullLen && fullText[target] !== ' ' && fullText[target] !== '\n') target++
      if (target < fullLen) target++
    } else {
      target = fullLen
    }

    revealedLength.value = target
    rafId = requestAnimationFrame(tick)
  }

  function start() {
    if (rafId) return
    draining = false
    isRevealing.value = true
    // Start at current text length to avoid flash if mounting mid-stream
    const text = getFullText()
    revealedLength.value = text?.length || 0
    rafId = requestAnimationFrame(tick)
  }

  function stop() {
    revealedLength.value = Infinity
    draining = false
    isRevealing.value = false
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
  }

  function drain() {
    // Stream ended — switch to fast drain to resolve remaining buffer smoothly
    draining = true
  }

  // Watch streaming state transitions
  watch(getIsStreaming, (streaming) => {
    if (streaming) {
      if (!rafId) start()
    } else if (rafId) {
      drain()
    }
  }, { immediate: true })

  onUnmounted(() => {
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
  })

  return { revealedLength, isRevealing }
}
