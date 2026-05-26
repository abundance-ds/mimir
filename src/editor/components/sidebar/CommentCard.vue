<template>
  <div
    class="comment-glass group absolute left-2 right-2 rounded-lg font-sans text-ink backdrop-blur-xl transition-opacity duration-200 ease-out"
    :class="{
      'comment-glass--expanded': mode === 'expanded' || mode === 'editing',
      'comment-glass--collapsed': mode === 'collapsed',
    }"
  >
    <template v-if="mode === 'editing'">
      <textarea
        ref="editArea"
        v-model="editText"
        class="min-h-[60px] w-full resize-y rounded-t border-0 bg-transparent px-2.5 py-2 text-[12.5px] leading-[1.5] text-ink outline-none placeholder:text-ink-3"
        rows="3"
        placeholder="Write a comment..."
        autocorrect="off"
        autocapitalize="off"
        @keydown.meta.enter="finishEditing"
        @keydown.ctrl.enter="finishEditing"
        @keydown.escape="cancelEditing"
        @click.stop
      />
      <div class="flex items-center justify-end gap-1 border-t border-rule-light px-2 py-1">
        <button class="h-6 rounded px-2.5 text-[11px] text-ink-3 hover:bg-chrome-high hover:text-ink" @click.stop="cancelEditing">Cancel</button>
        <button class="h-6 rounded px-2.5 text-[11px] font-semibold text-accent hover:bg-accent-soft" @click.stop="finishEditing">Save</button>
      </div>
    </template>

    <template v-else>
      <div class="px-2.5 pt-1.5 pb-2">
        <div class="flex items-center gap-1.5">
          <button
            v-if="selectable"
            class="flex size-[16px] shrink-0 items-center justify-center rounded-full border bg-transparent"
            :class="selected ? 'border-accent bg-accent-soft text-accent' : 'border-rule text-transparent hover:border-ink-3'"
            title="Select comment"
            @click.stop="$emit('toggle-select', comment.id)"
          >
            <IconCheck v-if="selected" :size="11" :stroke="2.4" />
          </button>

          <span class="text-[11px] font-semibold" :class="isAi ? 'text-accent' : 'text-ink'">{{ authorLabel }}</span>
          <span class="text-[10px] text-ink-3">{{ timeAgo(comment.created) }}</span>

          <!-- Reply count indicator (collapsed only, informational) -->
          <span
            v-if="mode === 'collapsed' && replyCount > 0"
            class="ml-0.5 flex items-center gap-0.5 text-[10px] text-ink-3"
          >
            <IconMessage :size="10" />
            <span class="font-mono font-semibold">{{ replyCount }}</span>
          </span>

          <div class="flex-1"></div>

          <!-- Done button: hover-reveal in collapsed, always visible in expanded -->
          <button
            v-if="!selectable"
            class="flex size-6 items-center justify-center rounded text-ink-3 hover:bg-chrome-mid hover:text-ink"
            :class="mode === 'collapsed' ? 'opacity-0 group-hover:opacity-100 transition-opacity' : ''"
            title="Done — remove comment"
            @click.stop="$emit('delete', comment.id)"
          >
            <IconCheck :size="14" :stroke="2.4" />
          </button>

          <!-- Context menu (expanded only) -->
          <button
            v-if="mode === 'expanded' && !selectable"
            ref="menuTriggerRef"
            class="-mr-1 flex size-6 items-center justify-center rounded text-ink-3 hover:bg-chrome-high hover:text-ink"
            title="More actions"
            @click.stop="toggleMenu"
          >
            <IconDots :size="14" />
          </button>
        </div>

        <div
          class="mt-1 select-text text-[12.5px] leading-[1.5]"
          :class="mode === 'collapsed' ? 'line-clamp-2 text-ink-2' : 'text-ink'"
          @dblclick.stop="mode === 'expanded' ? startEditing() : null"
        >{{ comment.text || '(empty)' }}</div>
      </div>

      <!-- Replies + reply input (expanded only) -->
      <div v-if="mode === 'expanded'" class="px-2.5 pb-2 pt-0.5">
        <!-- Existing replies -->
        <div v-if="replyCount > 0" class="space-y-2.5 mb-2.5">
          <div v-for="(reply, idx) in comment.replies" :key="reply.id" class="group/reply relative">
            <template v-if="editingReplyId === reply.id">
              <textarea
                ref="replyEditArea"
                v-model="replyEditText"
                class="w-full resize-y rounded border border-rule bg-surface px-2 py-1.5 text-[12px] leading-[1.4] text-ink outline-none placeholder:text-ink-3 focus:border-ink-3"
                rows="2"
                @keydown.meta.enter.prevent="finishReplyEdit(reply.id)"
                @keydown.ctrl.enter.prevent="finishReplyEdit(reply.id)"
                @keydown.escape.prevent="cancelReplyEdit"
                @click.stop
              />
              <div class="mt-1 flex items-center justify-end gap-1">
                <button class="h-5 rounded px-2 text-[10.5px] text-ink-3 hover:bg-chrome-high hover:text-ink" @click.stop="cancelReplyEdit">Cancel</button>
                <button class="h-5 rounded px-2 text-[10.5px] font-semibold text-accent hover:bg-accent-soft" @click.stop="finishReplyEdit(reply.id)">Save</button>
              </div>
            </template>
            <template v-else>
              <div class="flex items-center gap-1.5">
                <span class="text-[10.5px] font-semibold" :class="reply.author === 'ai' ? 'text-accent' : 'text-ink'">{{ reply.author === 'ai' ? 'Shoulders' : 'You' }}</span>
                <span class="text-[10px] text-ink-3">{{ timeAgo(reply.ts || reply.timestamp) }}</span>
                <div class="flex-1"></div>
                <button
                  class="flex size-5 items-center justify-center rounded text-ink-3 opacity-0 group-hover/reply:opacity-100 transition-opacity hover:bg-chrome-high hover:text-ink"
                  title="More"
                  @click.stop="toggleReplyMenu($event, reply.id)"
                >
                  <IconDots :size="12" />
                </button>
              </div>
              <div class="mt-0.5 select-text text-[12px] leading-[1.5] text-ink-2">{{ reply.text }}</div>
              <div v-if="reply.proposedEdit" class="mt-1 overflow-hidden rounded border border-rule-light font-mono text-[10px]">
                <div class="bg-rem/5 px-1.5 py-0.5 text-rem line-through">{{ reply.proposedEdit.oldText }}</div>
                <div class="bg-add/5 px-1.5 py-0.5 text-add">{{ reply.proposedEdit.newText }}</div>
              </div>
            </template>
          </div>
        </div>

        <!-- Reply input (always visible in expanded) -->
        <textarea
          ref="replyArea"
          v-model="replyText"
          class="w-full resize-none rounded border border-rule bg-surface/50 px-2 py-1.5 text-[12px] leading-[1.4] text-ink outline-none placeholder:text-ink-3 focus:border-ink-3 focus:bg-surface"
          rows="1"
          placeholder="Reply..."
          autocorrect="off"
          autocapitalize="off"
          @keydown.meta.enter.prevent="onReply"
          @keydown.ctrl.enter.prevent="onReply"
          @click.stop
          @focus="replyAreaFocused = true"
          @blur="replyAreaFocused = false"
          @input="autoGrowReply"
        />
        <Transition name="reply-actions">
          <div v-if="replyAreaFocused || replyText.trim()" class="mt-1 flex items-center justify-end gap-1">
            <button
              class="h-6 rounded px-2.5 text-[11px] font-semibold text-accent hover:bg-accent-soft disabled:opacity-40"
              :disabled="!replyText.trim()"
              @click.stop="onReply"
            >Reply</button>
          </div>
        </Transition>
      </div>
    </template>

    <!-- Context menu (comment) -->
    <Teleport to="body">
      <template v-if="menuOpen">
        <div class="fixed inset-0 z-[200]" @click="menuOpen = false" @contextmenu.prevent="menuOpen = false" />
        <div
          class="fixed z-[201] min-w-[120px] rounded-[6px] border border-rule bg-surface p-1"
          :style="menuStyle"
          style="box-shadow: 0 8px 30px rgba(0,0,0,.18)"
        >
          <button
            class="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left font-sans text-[12px] text-ink-2 hover:bg-chrome-high hover:text-ink"
            @click.stop="startEditingFromMenu"
          >
            <IconPencil :size="13" />
            Edit
          </button>
        </div>
      </template>

      <!-- Context menu (reply) -->
      <template v-if="replyMenuOpen">
        <div class="fixed inset-0 z-[200]" @click="replyMenuOpen = false" @contextmenu.prevent="replyMenuOpen = false" />
        <div
          class="fixed z-[201] min-w-[120px] rounded-[6px] border border-rule bg-surface p-1"
          :style="replyMenuStyle"
          style="box-shadow: 0 8px 30px rgba(0,0,0,.18)"
        >
          <button
            class="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left font-sans text-[12px] text-ink-2 hover:bg-chrome-high hover:text-ink"
            @click.stop="startReplyEdit"
          >
            <IconPencil :size="13" />
            Edit
          </button>
          <button
            class="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left font-sans text-[12px] text-rem hover:bg-chrome-high"
            @click.stop="deleteReply"
          >
            <IconTrash :size="13" />
            Delete
          </button>
        </div>
      </template>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onUnmounted } from 'vue'
import { IconCheck, IconDots, IconMessage, IconPencil, IconTrash } from '@tabler/icons-vue'

const props = defineProps({
  comment: { type: Object, required: true },
  active: Boolean,
  autoEdit: Boolean,
  selectable: Boolean,
  selected: Boolean,
})

const emit = defineEmits(['add-reply', 'delete', 'update-text', 'toggle-select', 'update-reply', 'delete-reply'])

const editing = ref(false)
const menuOpen = ref(false)
const editText = ref('')
const replyText = ref('')
const replyAreaFocused = ref(false)
const editArea = ref(null)
const replyArea = ref(null)
const replyEditArea = ref(null)
const menuTriggerRef = ref(null)
const menuStyle = ref({})

const editingReplyId = ref(null)
const replyEditText = ref('')
const replyMenuOpen = ref(false)
const replyMenuStyle = ref({})
const replyMenuTargetId = ref(null)

const isAi = computed(() => props.comment.author === 'ai')
const authorLabel = computed(() => (isAi.value ? 'Shoulders' : 'You'))
const replyCount = computed(() => props.comment.replies?.length || 0)

const mode = computed(() => {
  if (editing.value) return 'editing'
  if (props.active) return 'expanded'
  return 'collapsed'
})

watch(() => props.autoEdit, (val) => {
  if (val && !props.comment.text) {
    editing.value = true
    editText.value = ''
    retryFocus()
  }
}, { immediate: true })

function retryFocus() {
  let attempts = 0
  const tryFocus = () => {
    if (editArea.value) {
      editArea.value.focus()
      if (document.activeElement === editArea.value) return
    }
    if (attempts++ < 15) requestAnimationFrame(tryFocus)
  }
  nextTick(tryFocus)
}

watch(() => props.active, (val) => {
  if (!val) {
    editing.value = false
    menuOpen.value = false
    editingReplyId.value = null
    replyMenuOpen.value = false
  }
})

function startEditing() {
  if (!props.active) return
  menuOpen.value = false
  editing.value = true
  editText.value = props.comment.text || ''
  nextTick(() => editArea.value?.focus())
}

function startEditingFromMenu() {
  menuOpen.value = false
  startEditing()
}

function finishEditing() {
  const text = editText.value.trim()
  if (!text && !props.comment.text) {
    emit('delete', props.comment.id)
  } else if (text !== props.comment.text) {
    emit('update-text', props.comment.id, text)
  }
  editing.value = false
}

function cancelEditing() {
  if (!editText.value.trim() && !props.comment.text) {
    emit('delete', props.comment.id)
  }
  editing.value = false
}

function onReply() {
  const text = replyText.value.trim()
  if (!text) return
  emit('add-reply', props.comment.id, text)
  replyText.value = ''
  nextTick(() => {
    if (replyArea.value) {
      replyArea.value.style.height = ''
    }
  })
}

function autoGrowReply() {
  const el = replyArea.value
  if (!el) return
  el.style.height = ''
  el.style.height = Math.min(el.scrollHeight, 120) + 'px'
}

function toggleMenu() {
  if (menuOpen.value) { menuOpen.value = false; return }
  const rect = menuTriggerRef.value?.getBoundingClientRect()
  if (rect) {
    const menuW = 140
    const x = Math.max(8, rect.right - menuW)
    const y = Math.min(rect.bottom + 4, window.innerHeight - 80)
    menuStyle.value = { left: `${x}px`, top: `${y}px` }
  }
  menuOpen.value = true
}

function toggleReplyMenu(event, replyId) {
  replyMenuTargetId.value = replyId
  const rect = event.currentTarget.getBoundingClientRect()
  const menuW = 120
  const x = Math.max(8, rect.right - menuW)
  const y = Math.min(rect.bottom + 4, window.innerHeight - 80)
  replyMenuStyle.value = { left: `${x}px`, top: `${y}px` }
  replyMenuOpen.value = true
}

function startReplyEdit() {
  const reply = props.comment.replies?.find(r => r.id === replyMenuTargetId.value)
  if (!reply) return
  replyMenuOpen.value = false
  editingReplyId.value = reply.id
  replyEditText.value = reply.text || ''
  nextTick(() => replyEditArea.value?.[0]?.focus?.() || replyEditArea.value?.focus?.())
}

function finishReplyEdit(replyId) {
  const text = replyEditText.value.trim()
  if (text) {
    emit('update-reply', props.comment.id, replyId, text)
  }
  editingReplyId.value = null
  replyEditText.value = ''
}

function cancelReplyEdit() {
  editingReplyId.value = null
  replyEditText.value = ''
}

function deleteReply() {
  replyMenuOpen.value = false
  emit('delete-reply', props.comment.id, replyMenuTargetId.value)
  replyMenuTargetId.value = null
}

function onMenuKeydown(e) {
  if (e.key === 'Escape') { menuOpen.value = false; replyMenuOpen.value = false }
}

watch(menuOpen, (open) => {
  if (open) document.addEventListener('keydown', onMenuKeydown)
  else document.removeEventListener('keydown', onMenuKeydown)
})

watch(replyMenuOpen, (open) => {
  if (open) document.addEventListener('keydown', onMenuKeydown)
  else document.removeEventListener('keydown', onMenuKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', onMenuKeydown)
})

function timeAgo(iso) {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return new Date(iso).toLocaleDateString()
}
</script>

<style scoped>
.comment-glass {
  border: 1px solid color-mix(in srgb, var(--color-chrome-high) 40%, transparent);
}
.comment-glass--expanded {
  background: color-mix(in srgb, var(--color-surface) 82%, transparent);
  box-shadow: 0 2px 12px rgba(0,0,0,.08), 0 0 0 1px color-mix(in srgb, var(--color-accent) 15%, transparent);
}
.comment-glass--collapsed {
  background: color-mix(in srgb, var(--color-surface) 50%, transparent);
}
.comment-glass--collapsed:hover {
  background: color-mix(in srgb, var(--color-surface) 65%, transparent);
}
.reply-actions-enter-active, .reply-actions-leave-active { transition: opacity .1s ease; }
.reply-actions-enter-from, .reply-actions-leave-to { opacity: 0; }
</style>
