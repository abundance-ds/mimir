<template>
  <section v-if="all.length || !readonly" class="review-discussions" aria-label="Review discussions" @keydown.stop>
    <div class="review-discussion-bar">
      <button type="button" :aria-expanded="ui.open" @click="ui.open = !ui.open">Comments ({{ all.length }})</button>
      <button v-if="!readonly" type="button" :disabled="!selection?.text" title="Select text to add a comment (⇧⌘M)" @mousedown.prevent @click="start(selection)">Add comment</button>
      <span v-if="pending" role="status">{{ pending }} {{ pending === 1 ? 'comment change' : 'comment changes' }}</span>
      <label v-if="ui.open && resolved" class="review-resolved"><input v-model="ui.showResolved" type="checkbox"> Show resolved</label>
    </div>
    <div v-if="session.saveError" class="review-discussion-error" role="alert">
      Discussion changes are not saved. {{ session.saveError }}
      <button type="button" @click="retry">Retry save</button>
    </div>
    <div v-if="ui.open" ref="list" class="review-discussion-list">
      <p v-if="!readonly && !session.pending && hasDraft" class="review-discussion-empty" role="status">Post or clear your draft to complete the review.</p>
      <form v-if="ui.compose && !readonly" class="review-comment-compose" @submit.prevent="add">
        <blockquote>{{ ui.compose.text }}</blockquote>
        <textarea autocorrect="off" autocapitalize="off" autocomplete="off" spellcheck="false" writingsuggestions="false" v-model="ui.compose.body" aria-label="New comment" placeholder="Add a comment" rows="2" />
        <div class="review-thread-actions">
          <button type="submit" :disabled="busy || !ui.compose.body?.trim()">Add comment</button>
          <button type="button" @click="ui.compose = null">Cancel</button>
        </div>
      </form>
      <article v-for="thread in visible" :key="thread.id" :data-review-thread="thread.id" :class="{ 'is-active': ui.activeId === thread.id }" tabindex="-1">
        <button type="button" class="review-thread-heading" :aria-expanded="ui.activeId === thread.id" @click="ui.activeId = ui.activeId === thread.id ? null : thread.id">
          <span>{{ author(thread.author) }}</span>
          <span class="review-thread-summary">{{ thread.text }}</span>
          <span v-if="thread.status === 'resolved'">Resolved</span>
          <span v-else-if="thread.replies.length">{{ thread.replies.length }} {{ thread.replies.length === 1 ? 'reply' : 'replies' }}</span>
        </button>
        <div v-if="thread.change" class="review-thread-change">
          <span>{{ thread.change }}{{ !readonly && thread.decision !== 'pending' ? ` · ${thread.decision === 'accepted' ? 'Accepted' : 'Rejected'}` : '' }}</span>
          <template v-if="!readonly && thread.decision === 'pending'">
            <button type="button" aria-label="Accept comment change" @click="decide?.(thread.id, 'accepted')">Accept</button>
            <button type="button" aria-label="Reject comment change" @click="decide?.(thread.id, 'rejected')">Reject</button>
          </template>
        </div>
        <div v-if="ui.activeId === thread.id" class="review-thread-content">
          <p v-if="thread.detached" class="review-thread-state">{{ thread.detached === 'rejected' ? 'Proposed text not kept' : thread.detached === 'changed' ? 'Passage changed' : 'Text removed' }}</p>
          <blockquote>{{ thread.anchorText || thread.quote }}</blockquote>
          <p v-if="previousText(thread)" class="review-thread-previous"><span>Previously: </span>{{ previousText(thread) }}</p>
          <p v-for="reply in previousReplies(thread)" :key="reply.id" class="review-thread-previous"><span>Previous reply: </span>{{ reply.text }}</p>
          <p class="review-thread-body">{{ thread.text }}</p>
          <div v-for="reply in thread.replies" :key="reply.id" class="review-thread-reply">
            <span>{{ author(reply.author) }}</span><p>{{ reply.text }}</p>
          </div>
          <template v-if="!readonly">
            <form @submit.prevent="reply(thread)">
              <textarea autocorrect="off" autocapitalize="off" autocomplete="off" spellcheck="false" writingsuggestions="false" v-model="ui.drafts[thread.id]" :aria-label="`Reply to ${thread.text}`" placeholder="Reply" rows="2" />
              <div class="review-thread-actions">
                <button type="submit" :disabled="busy || !ui.drafts[thread.id]?.trim()">Reply</button>
                <button type="button" :disabled="busy" @click="run(thread.status === 'resolved' ? 'reopen' : 'resolve', { comment_id: thread.id })">{{ thread.status === 'resolved' ? 'Reopen' : 'Resolve' }}</button>
                <details><summary aria-label="More discussion actions">More</summary><button type="button" :disabled="busy" @click="run('delete', { comment_id: thread.id })">Delete discussion</button></details>
              </div>
            </form>
          </template>
        </div>
      </article>
      <p v-if="!visible.length && !ui.compose" class="review-discussion-empty">{{ resolved ? 'All discussions are resolved.' : 'No discussions yet. Select a passage to add a comment.' }}</p>
      <p v-if="error" class="review-discussion-error" role="alert">{{ error }}</p>
    </div>
  </section>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { reviewComments, pendingCommentChanges } from '../../reviewComments.js'
import { retryReviewSave, scheduleReviewSave } from '../../reviewPersistence.js'

const props = defineProps({ session: { type: Object, required: true }, readonly: Boolean, selection: Object, action: Function, decide: Function })
const list = ref(null)
const error = ref('')
const busy = ref(false)
const ui = computed(() => props.session.commentUI)
const all = computed(() => reviewComments(props.session, props.session.result, { includeRemoved: true }))
const visible = computed(() => all.value.filter(thread => ui.value.showResolved || thread.status !== 'resolved' || thread.change))
const resolved = computed(() => all.value.some(thread => thread.status === 'resolved'))
const pending = computed(() => pendingCommentChanges(props.session))
const hasDraft = computed(() => ui.value.compose?.body?.trim() || Object.values(ui.value.drafts).some(text => text?.trim()))
function author(value) { return ['ai', 'agent', 'assistant'].includes(value) ? 'Agent' : 'You' }
function previousText(thread) {
  const before = props.session.comments.find(record => record.id === thread.id)?.before?.text
  return before && before !== thread.text ? before : ''
}
function previousReplies(thread) {
  if (!thread.change) return []
  const before = props.session.comments.find(record => record.id === thread.id)?.before
  return (before?.replies || []).filter(reply => !thread.replies.some(current => current.id === reply.id && current.text === reply.text))
}
async function open(id) {
  ui.value.open = true
  ui.value.activeId = id
  if (all.value.find(thread => thread.id === id)?.status === 'resolved') ui.value.showResolved = true
  await nextTick()
  const item = [...(list.value?.querySelectorAll('[data-review-thread]') || [])].find(element => element.dataset.reviewThread === id)
  if (item && list.value) { list.value.scrollTop = item.offsetTop - list.value.offsetTop; item.focus({ preventScroll: true }) }
}
async function start(selection) {
  if (props.readonly || !selection?.text) return
  ui.value.open = true
  ui.value.compose = { ...selection, body: ui.value.compose?.body || '' }
  await nextTick()
  list.value?.querySelector('textarea')?.focus({ preventScroll: true })
}
async function run(action, input, selection) {
  if (busy.value || !props.action) return null
  busy.value = true
  error.value = ''
  try { return await props.action(action, input, selection) }
  catch (cause) { error.value = cause?.message || String(cause); return null }
  finally { busy.value = false }
}
async function add() {
  const selection = ui.value.compose
  const result = await run('add', { anchor_text: selection.text, text: selection.body }, selection)
  if (result) { ui.value.compose = null; ui.value.activeId = result.comment_id }
}
async function reply(thread) {
  if (await run('reply', { comment_id: thread.id, text: ui.value.drafts[thread.id] })) ui.value.drafts[thread.id] = ''
}
async function retry() { try { await retryReviewSave(props.session) } catch { /* The save error remains visible. */ } }
watch(ui, () => { if (!props.readonly) scheduleReviewSave(props.session) }, { deep: true })
defineExpose({ open, start })
</script>

<style scoped>
.review-discussions { flex: none; min-width: 0; border-top: 1px solid var(--color-rule-light); color: var(--color-ink); background: var(--color-chrome); font: 12px var(--font-sans); }
.review-discussion-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-height: 30px; padding: 0 12px; color: var(--color-ink-2); }
button, summary { min-height: 28px; padding: 3px 6px; cursor: pointer; }
button:hover:not(:disabled), summary:hover { background: var(--color-chrome-mid); }
button:disabled { opacity: .45; cursor: default; }
button:focus-visible, summary:focus-visible, textarea:focus-visible { outline: 1px solid var(--color-accent); outline-offset: -1px; }
.review-resolved { display: flex; align-items: center; gap: 5px; margin-left: auto; }
.review-discussion-list { position: relative; max-height: 38vh; overflow: auto; overscroll-behavior: contain; }
article { border-top: 1px solid var(--color-rule-light); }
article.is-active { background: var(--color-surface); }
.review-thread-heading { display: flex; align-items: baseline; gap: 8px; width: 100%; text-align: left; padding: 6px 14px; color: var(--color-ink-2); }
.review-thread-summary { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-ink); }
.review-thread-content, .review-comment-compose { padding: 4px 14px 12px; }
blockquote { margin: 4px 0 10px; padding: 3px 9px; border-left: 2px solid var(--color-rule); color: var(--color-ink-2); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 100px; overflow: auto; user-select: text; }
.review-thread-body, .review-thread-reply p, .review-thread-previous { margin: 5px 0 12px; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
.review-thread-reply { padding-top: 7px; border-top: 1px solid var(--color-rule-light); }
.review-thread-reply > span, .review-thread-state, .review-thread-previous { color: var(--color-ink-3); }
.review-thread-state { margin: 2px 0 5px; }
.review-thread-change { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 2px 14px; color: var(--color-ink-2); }
textarea { display: block; width: 100%; padding: 6px 8px; resize: vertical; min-height: 50px; max-height: 140px; border: 1px solid var(--color-rule); background: var(--color-surface); color: var(--color-ink); font: inherit; }
.review-thread-actions { display: flex; align-items: center; gap: 8px; }
.review-thread-actions details { margin-left: auto; }
.review-thread-actions details[open] { display: flex; }
.review-discussion-error { padding: 5px 14px; color: var(--color-rem); overflow-wrap: anywhere; }
.review-discussion-empty { padding: 8px 14px; color: var(--color-ink-3); }
</style>
