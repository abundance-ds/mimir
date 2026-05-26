import { ref, onMounted, onUnmounted } from 'vue'
import { useFloating, offset, flip, shift, autoUpdate } from '@floating-ui/vue'

export function usePopover(options = {}) {
  const {
    placement = 'top-end',
    offsetPx = 6,
  } = options

  const referenceRef = ref(null)
  const floatingRef = ref(null)
  const isOpen = ref(false)

  const { floatingStyles } = useFloating(referenceRef, floatingRef, {
    placement,
    strategy: 'fixed',
    middleware: [offset(offsetPx), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  })

  function toggle() {
    isOpen.value = !isOpen.value
  }

  function close() {
    isOpen.value = false
  }

  function onPointerDown(event) {
    if (!isOpen.value) return
    const target = event.target
    if (referenceRef.value && referenceRef.value.contains(target)) return
    if (floatingRef.value && floatingRef.value.contains(target)) return
    isOpen.value = false
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && isOpen.value) {
      isOpen.value = false
    }
  }

  onMounted(() => {
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
  })
  onUnmounted(() => {
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('keydown', onKeyDown, true)
  })

  return { referenceRef, floatingRef, floatingStyles, isOpen, toggle, close }
}
