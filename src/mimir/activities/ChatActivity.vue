<template>
  <div
    data-chat-activity
    class="relative flex h-full min-h-0 flex-col overflow-hidden bg-surface"
    @keydown.esc="onEscape"
  >
    <div
      v-if="chat.status.state === 'needs_credentials'"
      class="grid min-h-0 flex-1 place-items-center overflow-y-auto px-5 py-8"
    >
      <form
        data-chat-setup
        class="w-full max-w-sm border border-rule bg-chrome-high p-5"
        @submit.prevent="connect"
      >
        <div class="flex items-start gap-3">
          <span class="grid size-8 shrink-0 place-items-center bg-chrome text-ink-2">
            <IconMessages :size="17" :stroke-width="1.8" />
          </span>
          <div>
            <h2 class="text-[13px] font-semibold text-ink">Connect to team chat</h2>
            <p class="mt-1 text-[10px] leading-relaxed text-ink-3">
              Use the account and passphrase from your team owner. Mimir keeps the passphrase in your system keychain.
            </p>
            <p v-if="chat.status.diagnostic" class="mt-2 text-[9px] leading-relaxed text-rem">
              {{ chat.status.diagnostic }}
            </p>
          </div>
        </div>

        <label class="chat-field mt-5">
          <span>Display name</span>
          <input ref="setupName" v-model="setup.displayName" autocomplete="name" />
        </label>
        <label class="chat-field mt-3">
          <span>Account</span>
          <input v-model="setup.account" autocapitalize="none" autocomplete="username" spellcheck="false" />
        </label>
        <label class="chat-field mt-3">
          <span>Passphrase</span>
          <input ref="setupPassword" v-model="setup.password" type="password" autocomplete="current-password" />
        </label>
        <details class="mt-3 text-[10px] text-ink-3">
          <summary class="cursor-default py-1 hover:text-ink">Advanced</summary>
          <label class="chat-field mt-2">
            <span>Server</span>
            <input v-model="setup.endpoint" autocapitalize="none" spellcheck="false" />
          </label>
        </details>
        <p v-if="setup.error" class="mt-3 text-[10px] leading-relaxed text-rem" role="alert">
          {{ setup.error }}
        </p>
        <button
          type="submit"
          class="mt-4 h-8 bg-accent px-4 text-[10px] font-semibold text-accent-ink hover:bg-accent-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          :disabled="setup.busy"
        >
          {{ setup.busy ? 'Connecting…' : 'Connect' }}
        </button>
      </form>
    </div>

    <template v-else>
      <div
        v-if="chat.status.state !== 'connected'"
        data-chat-connection-state
        class="flex shrink-0 items-center gap-2 border-b border-rule-light bg-chrome-high px-3 py-2 text-[10px] text-ink-2"
        role="status"
      >
        <IconPlugConnectedX :size="14" :stroke-width="1.8" class="shrink-0 text-ink-3" />
        <span class="min-w-0 flex-1">
          {{ connectionNotice }}
        </span>
        <button
          type="button"
          class="h-6 px-2 font-semibold text-ink-2 hover:bg-chrome hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          @click="chat.reconnect()"
        >
          Retry
        </button>
      </div>

      <div
        v-if="!chat.activeTarget"
        class="grid min-h-0 flex-1 place-items-center px-6 text-center"
      >
        <div class="max-w-xs">
          <IconMessages :size="24" :stroke-width="1.5" class="mx-auto text-ink-4" />
          <p class="mt-3 text-[12px] font-semibold text-ink">Start the team conversation</p>
          <p class="mt-1 text-[10px] leading-relaxed text-ink-3">
            Create a channel, join one, or message a teammate directly.
          </p>
          <button
            type="button"
            class="mt-4 h-8 bg-accent px-3 text-[10px] font-semibold text-accent-ink hover:bg-accent-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            @click="openNewFlow('menu')"
          >
            New chat
          </button>
        </div>
      </div>

      <template v-else-if="chat.searchState.open">
        <section data-chat-search class="flex min-h-0 flex-1 flex-col">
          <form class="flex shrink-0 items-center gap-2 border-b border-rule bg-chrome-high p-2" @submit.prevent="chat.runSearch()">
            <div class="relative min-w-0 flex-1">
              <IconSearch :size="14" class="pointer-events-none absolute left-2 top-2 text-ink-4" />
              <input
                ref="searchInput"
                v-model="chat.searchState.query"
                data-chat-search-input
                class="h-8 w-full border border-rule bg-surface pl-7 pr-2 text-[11px] text-ink outline-none focus:border-accent"
                :placeholder="`Search ${chat.activeTarget}`"
                aria-label="Search chat messages"
              />
            </div>
            <div class="flex h-8 shrink-0 border border-rule p-0.5" aria-label="Search scope">
              <button
                v-for="scope in SEARCH_SCOPES"
                :key="scope.id"
                type="button"
                class="px-2 text-[9px] font-medium text-ink-3 hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                :class="{ 'bg-chrome text-ink': chat.searchState.scope === scope.id }"
                :aria-pressed="chat.searchState.scope === scope.id"
                @click="chat.searchState.scope = scope.id"
              >
                {{ scope.label }}
              </button>
            </div>
            <button
              type="button"
              title="Close search"
              aria-label="Close search"
              class="grid size-8 shrink-0 place-items-center text-ink-3 hover:bg-chrome hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              @click="chat.closeSearch()"
            >
              <IconX :size="15" />
            </button>
          </form>

          <div class="min-h-0 flex-1 overflow-y-auto">
            <div v-if="chat.searchState.loading" class="p-5 text-center text-[10px] text-ink-3" role="status">
              Searching cached chat…
            </div>
            <div v-else-if="chat.searchState.error" class="p-5 text-center" role="alert">
              <p class="text-[11px] font-semibold text-ink">Search failed</p>
              <p class="mt-1 text-[10px] text-rem">{{ chat.searchState.error }}</p>
            </div>
            <div
              v-else-if="chat.searchState.query.trim() && !chat.searchState.results.length"
              class="p-5 text-center"
            >
              <p class="text-[11px] font-semibold text-ink">No matching messages</p>
              <p class="mt-1 text-[10px] text-ink-3">Try fewer or different words.</p>
            </div>
            <div v-else-if="!chat.searchState.query.trim()" class="p-5 text-center text-[10px] text-ink-3">
              Search the local chat cache. This also works offline.
            </div>
            <button
              v-for="message in chat.searchState.results"
              :key="message.id"
              type="button"
              class="block w-full border-b border-rule-light px-4 py-3 text-left hover:bg-chrome-high focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
              @click="chat.openSearchResult(message)"
            >
              <span class="flex items-baseline gap-2">
                <span class="text-[10px] font-semibold text-ink">{{ senderName(message) }}</span>
                <span class="font-mono text-[8px] text-ink-4">{{ message.target }} · {{ compactDate(message.serverTime) }}</span>
              </span>
              <span class="mt-1 line-clamp-2 block text-[10px] leading-relaxed text-ink-2">{{ message.body }}</span>
            </button>
          </div>
        </section>
      </template>

      <template v-else>
        <div
          ref="timeline"
          data-chat-timeline
          class="chat-timeline min-h-0 flex-1 overflow-y-auto"
          role="log"
          aria-label="Chat messages"
          aria-live="off"
          @scroll="onTimelineScroll"
        >
          <div class="mx-auto w-full max-w-3xl px-3 pb-4 pt-2">
            <div
              v-if="chat.loadingByTarget[chat.activeTarget] && !messages.length"
              class="py-8 text-center text-[10px] text-ink-3"
              role="status"
            >
              Loading messages…
            </div>
            <button
              v-else-if="messages.length && !chat.olderComplete[chat.activeTarget]"
              type="button"
              data-chat-load-older
              class="mx-auto mb-3 block h-7 px-3 text-[9px] font-medium text-ink-3 hover:bg-chrome-high hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              :disabled="chat.loadingByTarget[chat.activeTarget]"
              @click="loadOlder"
            >
              {{ chat.loadingByTarget[chat.activeTarget] ? 'Loading…' : 'Earlier messages' }}
            </button>

            <div
              v-if="!chat.loadingByTarget[chat.activeTarget] && !messages.length"
              class="py-12 text-center"
            >
              <p class="text-[11px] font-semibold text-ink">No messages yet</p>
              <p class="mt-1 text-[10px] text-ink-3">Start the conversation.</p>
            </div>

            <template v-for="(message, index) in messages" :key="message.id">
              <div
                v-if="showsDay(index)"
                class="my-4 flex items-center gap-3"
                role="separator"
                :aria-label="longDate(message.serverTime)"
              >
                <span class="h-px flex-1 bg-rule-light" />
                <span class="font-mono text-[8px] uppercase tracking-[0.08em] text-ink-4">
                  {{ dayLabel(message.serverTime) }}
                </span>
                <span class="h-px flex-1 bg-rule-light" />
              </div>

              <div
                v-if="message.id === newMarkerId"
                data-chat-new-marker
                class="my-3 flex items-center gap-3"
                role="separator"
                aria-label="New messages"
              >
                <span class="h-px flex-1 bg-accent/50" />
                <span class="font-mono text-[8px] uppercase tracking-[0.1em] text-accent">New messages</span>
                <span class="h-px flex-1 bg-accent/50" />
              </div>

              <article
                :id="`chat-message-${message.id}`"
                :data-chat-message="message.id"
                class="chat-message group relative rounded-sm pr-9"
                :class="[
                  groupStart(index) ? 'mt-3 pt-1' : 'mt-0.5',
                  {
                    'bg-accent-soft': highlightedId === message.id,
                    'bg-accent-soft/50': message.mentioned && !message.own && highlightedId !== message.id,
                  },
                ]"
                :aria-label="messageAriaLabel(message)"
                :tabindex="focusableMessageId === message.id ? 0 : -1"
                @focus="focusedMessageId = message.id"
                @dblclick="beginReply(message)"
                @keydown="onMessageKeydown($event, message, index)"
              >
                <div v-if="groupStart(index)" class="flex min-w-0 items-baseline gap-2 px-2">
                  <span class="truncate text-[10px] font-semibold text-ink">
                    {{ senderName(message) }}
                  </span>
                  <component
                    :is="message.activityId ? 'button' : 'span'"
                    v-if="message.agentLabel"
                    :type="message.activityId ? 'button' : undefined"
                    :title="message.activityId ? 'Open the agent Activity' : undefined"
                    class="shrink-0 bg-chrome px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.05em] text-ink-2"
                    :class="{ 'hover:bg-chrome-mid hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent': message.activityId }"
                    @click.stop="message.activityId && $emit('openActivity', message.activityId)"
                  >
                    Agent · via {{ message.senderAccount || chat.status.account }}
                  </component>
                  <time
                    class="shrink-0 font-mono text-[8px] tabular-nums text-ink-4"
                    :datetime="message.serverTime"
                    :title="exactDate(message.serverTime)"
                  >
                    {{ timeLabel(message.serverTime) }}
                  </time>
                  <span
                    v-if="message.editedAt && !message.deleted"
                    class="font-mono text-[8px] text-ink-4"
                    :title="`Edited ${exactDate(message.editedAt)}`"
                  >
                    edited
                  </span>
                </div>

                <button
                  v-if="message.replyTo"
                  type="button"
                  class="mx-2 mt-1 block max-w-[calc(100%-16px)] truncate bg-chrome-high px-2 py-1 text-left text-[9px] text-ink-3 hover:bg-chrome hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                  :tabindex="focusableMessageId === message.id ? 0 : -1"
                  @click.stop="jumpToReply(message.replyTo)"
                >
                  <template v-if="messageById.get(message.replyTo)">
                    <span class="font-semibold">{{ senderName(messageById.get(message.replyTo)) }}</span>
                    · {{ singleLine(messageById.get(message.replyTo).body) }}
                  </template>
                  <template v-else>Earlier message unavailable</template>
                </button>

                <form
                  v-if="editingId === message.id"
                  class="mx-2 my-1 bg-chrome-high p-2"
                  @submit.prevent="submitEdit(message)"
                >
                  <textarea
                    v-model="editDraft"
                    :data-chat-edit-input="message.id"
                    rows="2"
                    class="max-h-28 w-full resize-y border border-rule bg-surface px-2 py-1.5 text-[11px] leading-relaxed text-ink outline-none focus:border-accent"
                    :disabled="editingBusy"
                    @keydown.esc.prevent="cancelEdit"
                    @keydown.meta.enter.prevent="submitEdit(message)"
                    @keydown.ctrl.enter.prevent="submitEdit(message)"
                  />
                  <div class="mt-1.5 flex items-center gap-2">
                    <span class="min-w-0 flex-1 text-[8px] text-ink-4">
                      {{ editDraftBytes }}/350 bytes · ⌘Enter to save
                    </span>
                    <button
                      type="button"
                      class="h-6 px-2 text-[9px] text-ink-3 hover:bg-chrome hover:text-ink"
                      :disabled="editingBusy"
                      @click="cancelEdit"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      class="h-6 bg-accent px-2.5 text-[9px] font-semibold text-accent-ink disabled:opacity-40"
                      :disabled="!canSaveEdit || editingBusy"
                    >
                      {{ editingBusy ? 'Saving…' : 'Save' }}
                    </button>
                  </div>
                </form>

                <div
                  v-else-if="!isAttachmentFallback(message)"
                  class="px-2 py-0.5 text-[11px] leading-[1.55]"
                  :class="message.deleted ? 'italic text-ink-4' : 'text-ink'"
                >
                  <span v-if="message.deleted">Message deleted</span>
                  <template v-for="(block, blockIndex) in messageBlocks(message.body)" :key="blockIndex">
                    <pre
                      v-if="block.code"
                      class="my-1 max-w-full overflow-x-auto border border-rule bg-chrome-high p-2 font-mono text-[10px] leading-relaxed text-ink-2"
                    ><code>{{ block.text }}</code></pre>
                    <span v-else class="whitespace-pre-wrap break-words"><template
                      v-for="(part, partIndex) in textParts(block.text)"
                      :key="partIndex"
                    ><button
                      v-if="part.chatLink"
                      type="button"
                      class="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
                      :tabindex="focusableMessageId === message.id ? 0 : -1"
                      @click.stop="openPermalink(part.text)"
                    >{{ part.text }}</button><a
                      v-else-if="part.url"
                      :href="part.text"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
                      :tabindex="focusableMessageId === message.id ? 0 : -1"
                      @click.stop
                    >{{ part.text }}</a><template v-else>{{ part.text }}</template></template></span>
                  </template>
                </div>

                <div
                  v-if="!message.deleted && message.attachments?.length"
                  class="grid max-w-md gap-1 px-2 pb-1 pt-1"
                  data-chat-attachments
                >
                  <button
                    v-for="attachment in message.attachments"
                    :key="attachment.id"
                    type="button"
                    class="group/attachment overflow-hidden bg-chrome-high text-left hover:bg-chrome focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                    :disabled="attachmentBusy[attachment.id]"
                    :tabindex="focusableMessageId === message.id ? 0 : -1"
                    @click.stop="openAttachment(attachment)"
                  >
                    <img
                      v-if="chat.attachmentPreviews[attachment.id]"
                      :src="chat.attachmentPreviews[attachment.id]"
                      :alt="attachment.name"
                      class="max-h-64 w-full bg-chrome object-contain"
                    />
                    <span class="flex min-h-11 items-center gap-2 px-2.5 py-2">
                      <span class="grid size-7 shrink-0 place-items-center bg-surface text-ink-3">
                        <IconPhoto v-if="isPreviewableImage(attachment)" :size="14" />
                        <IconFile v-else :size="14" />
                      </span>
                      <span class="min-w-0 flex-1">
                        <strong class="block truncate text-[10px] font-semibold text-ink">
                          {{ attachment.name }}
                        </strong>
                        <small class="mt-0.5 block font-mono text-[8px] text-ink-4">
                          {{ formatBytes(attachment.size) }} · {{ attachmentType(attachment) }}
                        </small>
                      </span>
                      <span class="shrink-0 text-ink-4 group-hover/attachment:text-ink">
                        <IconLoader2 v-if="attachmentBusy[attachment.id]" :size="14" class="animate-spin" />
                        <IconExternalLink v-else-if="attachment.localPath" :size="14" />
                        <IconDownload v-else :size="14" />
                      </span>
                    </span>
                  </button>
                </div>

                <div
                  v-if="!message.deleted && message.reactions?.length"
                  class="flex flex-wrap gap-1 px-2 pb-0.5 pt-1"
                  data-chat-reactions
                >
                  <button
                    v-for="reaction in message.reactions"
                    :key="reaction.value"
                    type="button"
                    class="flex h-6 items-center gap-1 bg-chrome px-1.5 text-[10px] text-ink-2 hover:bg-chrome-mid focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                    :class="{ 'bg-accent-soft text-accent': reaction.own }"
                    :title="reaction.reactors?.join(', ')"
                    :aria-pressed="reaction.own"
                    :tabindex="focusableMessageId === message.id ? 0 : -1"
                    @click.stop="toggleReaction(message, reaction.value)"
                  >
                    <span>{{ reaction.value }}</span>
                    <span class="font-mono text-[8px] tabular-nums">{{ reaction.count }}</span>
                  </button>
                </div>

                <div
                  v-if="!message.deleted && editingId !== message.id"
                  class="chat-message-actions absolute right-1 top-1 flex bg-surface shadow-sm"
                  data-chat-actions
                >
                  <button
                    type="button"
                    class="chat-message-action"
                    title="Add reaction"
                    aria-label="Add reaction"
                    :tabindex="focusableMessageId === message.id ? 0 : -1"
                    @click.stop="toggleActions(message.id, 'reactions')"
                  >
                    <IconMoodPlus :size="13" :stroke-width="1.8" />
                  </button>
                  <button
                    type="button"
                    class="chat-message-action chat-reply-action"
                    title="Reply"
                    :aria-label="`Reply to ${senderName(message)}`"
                    :tabindex="focusableMessageId === message.id ? 0 : -1"
                    @click.stop="beginReply(message)"
                  >
                    <IconArrowBackUp :size="13" :stroke-width="1.8" />
                  </button>
                  <button
                    type="button"
                    class="chat-message-action"
                    title="More actions"
                    aria-label="More message actions"
                    :tabindex="focusableMessageId === message.id ? 0 : -1"
                    @click.stop="toggleActions(message.id, 'menu')"
                  >
                    <IconDots :size="14" />
                  </button>
                </div>

                <div
                  v-if="openActionsId === message.id"
                  class="absolute right-1 top-8 z-20 min-w-40 border border-rule bg-surface p-1 shadow-xl"
                  data-chat-actions
                  @pointerdown.stop
                >
                  <div
                    v-if="actionsMode === 'reactions'"
                    class="grid grid-cols-5 gap-0.5 p-1"
                    aria-label="Choose a reaction"
                  >
                    <button
                      v-for="reaction in QUICK_REACTIONS"
                      :key="reaction"
                      type="button"
                      class="grid size-8 place-items-center text-base hover:bg-chrome focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                      @click="toggleReaction(message, reaction)"
                    >
                      {{ reaction }}
                    </button>
                  </div>
                  <template v-else>
                    <button class="chat-action-menu-item" @click="copyMessageLink(message)">
                      <IconLink :size="13" />
                      <span>{{ copiedMessageId === message.id ? 'Link copied' : 'Copy message link' }}</span>
                    </button>
                    <button
                      v-if="message.own && !message.attachments?.length"
                      class="chat-action-menu-item"
                      @click="beginEdit(message)"
                    >
                      <IconPencil :size="13" />
                      <span>Edit message</span>
                    </button>
                    <button
                      v-if="message.own && deleteConfirmId !== message.id"
                      class="chat-action-menu-item text-rem"
                      @click="deleteConfirmId = message.id"
                    >
                      <IconTrash :size="13" />
                      <span>Delete message</span>
                    </button>
                    <div v-else-if="message.own" class="p-1.5">
                      <p class="text-[9px] font-semibold text-ink">Delete this message?</p>
                      <p class="mt-0.5 text-[8px] leading-relaxed text-ink-3">Replies keep a deleted-message marker.</p>
                      <div class="mt-2 flex justify-end gap-1">
                        <button class="h-6 px-2 text-[9px] text-ink-3 hover:bg-chrome" @click="deleteConfirmId = ''">
                          Cancel
                        </button>
                        <button class="h-6 bg-rem px-2 text-[9px] font-semibold text-white" @click="deleteOwnMessage(message)">
                          Delete
                        </button>
                      </div>
                    </div>
                  </template>
                </div>
              </article>
            </template>
          </div>
        </div>

        <p class="sr-only" aria-live="polite" aria-atomic="true">{{ announcement }}</p>

        <button
          v-if="newBelow"
          type="button"
          data-chat-new-below
          class="absolute bottom-[76px] left-1/2 z-10 -translate-x-1/2 bg-ink px-3 py-1.5 text-[9px] font-semibold text-surface shadow-lg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          @click="scrollToBottom"
        >
          {{ newBelow }} new {{ newBelow === 1 ? 'message' : 'messages' }} ↓
        </button>

        <form
          data-chat-composer
          class="shrink-0 border-t border-rule bg-chrome-high p-2"
          @submit.prevent="submitMessage"
        >
          <div
            v-if="uploads.length"
            class="mb-1.5 grid gap-1"
            aria-live="polite"
          >
            <div
              v-for="upload in uploads"
              :key="upload.id"
              class="flex min-h-7 items-center gap-2 bg-chrome px-2 text-[9px]"
            >
              <IconLoader2 v-if="upload.state === 'uploading'" :size="12" class="shrink-0 animate-spin text-accent" />
              <IconPaperclip v-else :size="12" class="shrink-0 text-ink-3" />
              <span class="min-w-0 flex-1 truncate text-ink-2">{{ upload.name }}</span>
              <span :class="upload.state === 'error' ? 'text-rem' : 'text-ink-4'">
                {{ upload.state === 'uploading' ? 'Uploading…' : upload.state === 'error' ? upload.error : 'Sent' }}
              </span>
            </div>
          </div>
          <div
            v-if="replyingTo"
            class="mb-1.5 flex min-w-0 items-center gap-2 bg-chrome px-2 py-1.5 text-[9px] text-ink-3"
          >
            <IconArrowBackUp :size="12" class="shrink-0" />
            <span class="min-w-0 flex-1 truncate">
              Replying to <strong class="text-ink-2">{{ senderName(replyingTo) }}</strong>
              — {{ singleLine(replyingTo.body) }}
            </span>
            <button
              type="button"
              title="Cancel reply"
              aria-label="Cancel reply"
              class="grid size-5 shrink-0 place-items-center hover:bg-chrome-high hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              @click="replyingId = ''"
            >
              <IconX :size="12" />
            </button>
          </div>
          <p
            v-if="typingLabel"
            class="mb-1 min-h-3 px-1 text-[9px] text-ink-3"
            aria-live="polite"
          >
            {{ typingLabel }}
          </p>
          <div class="flex items-end gap-2">
            <button
              type="button"
              class="grid size-9 shrink-0 place-items-center text-ink-3 hover:bg-chrome hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-35"
              title="Attach files"
              aria-label="Attach files"
              :disabled="!chat.connected || uploading"
              @click="pickAttachments"
            >
              <IconPaperclip :size="16" :stroke-width="1.8" />
            </button>
            <textarea
              ref="composer"
              v-model="draft"
              data-chat-composer-input
              rows="1"
              class="max-h-[132px] min-h-9 min-w-0 flex-1 resize-none border border-rule bg-surface px-2.5 py-2 text-[11px] leading-[1.45] text-ink outline-none placeholder:text-ink-4 focus:border-accent disabled:bg-chrome disabled:text-ink-3"
              :placeholder="composerPlaceholder"
              :disabled="!chat.connected || sending"
              @input="onComposerInput"
              @blur="finishTyping"
              @keydown="onComposerKeydown"
              @paste="onComposerPaste"
            />
            <button
              type="submit"
              class="grid size-9 shrink-0 place-items-center bg-accent text-accent-ink hover:bg-accent-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-35"
              :disabled="!canSend"
              title="Send message"
              aria-label="Send message"
            >
              <IconArrowUp :size="16" :stroke-width="2" />
            </button>
          </div>
          <div class="mt-1 flex min-h-3 items-center">
            <span v-if="composerError" class="text-[9px] text-rem" role="alert">{{ composerError }}</span>
            <span v-else-if="!chat.connected" class="text-[9px] text-ink-3">
              Reconnect to send. Your draft is safe.
            </span>
            <span v-else class="ml-auto font-mono text-[8px] text-ink-4">
              Enter to send · Shift+Enter for a new line
            </span>
          </div>
        </form>
      </template>
    </template>

    <div
      v-if="dragActive"
      class="pointer-events-none absolute inset-2 z-30 grid place-items-center border border-accent bg-surface/95"
      role="status"
    >
      <div class="text-center">
        <IconPaperclip :size="22" class="mx-auto text-accent" />
        <p class="mt-2 text-[11px] font-semibold text-ink">Drop to share in {{ chat.activeTarget }}</p>
        <p class="mt-1 text-[9px] text-ink-3">Up to 25 MB per file</p>
      </div>
    </div>

    <div
      v-if="newFlow.open"
      data-chat-new-flow
      class="absolute inset-0 z-40 grid place-items-center bg-ink/15 p-4"
      @pointerdown.self="closeNewFlow"
    >
      <section
        ref="newFlowDialog"
        class="w-full max-w-sm border border-rule bg-surface p-4 shadow-xl"
        role="dialog"
        aria-modal="true"
        :aria-label="newFlowTitle"
        @keydown="onNewFlowKeydown"
      >
        <div class="flex items-center gap-2">
          <button
            v-if="newFlow.mode !== 'menu'"
            type="button"
            title="Back"
            aria-label="Back"
            class="grid size-7 place-items-center text-ink-3 hover:bg-chrome hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            @click="newFlow.mode = 'menu'"
          >
            <IconArrowLeft :size="14" />
          </button>
          <h2 class="min-w-0 flex-1 text-[12px] font-semibold text-ink">{{ newFlowTitle }}</h2>
          <button
            type="button"
            title="Close"
            aria-label="Close"
            class="grid size-7 place-items-center text-ink-3 hover:bg-chrome hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            @click="closeNewFlow"
          >
            <IconX :size="14" />
          </button>
        </div>

        <div v-if="newFlow.mode === 'menu'" class="mt-3 grid gap-1">
          <button ref="newFlowMenuFirst" class="new-chat-choice" @click="newFlow.mode = 'channel'">
            <IconHash :size="16" />
            <span><strong>New channel</strong><small>Create a room for ongoing work</small></span>
          </button>
          <button class="new-chat-choice" @click="newFlow.mode = 'join'">
            <IconDoorEnter :size="16" />
            <span><strong>Join channel</strong><small>Open an existing room by name</small></span>
          </button>
          <button class="new-chat-choice" @click="prepareDirect">
            <IconUser :size="16" />
            <span><strong>Direct message</strong><small>Start a conversation with one person</small></span>
          </button>
        </div>

        <form v-else-if="newFlow.mode === 'channel'" class="mt-3" @submit.prevent="submitNewChannel">
          <label class="chat-field">
            <span>Channel name</span>
            <div class="flex border border-rule bg-surface focus-within:border-accent">
              <span class="grid w-7 place-items-center text-[11px] text-ink-4">#</span>
              <input ref="newFlowInput" v-model="newFlow.name" class="border-0" placeholder="product" />
            </div>
          </label>
          <label class="chat-field mt-3">
            <span>Topic <em>optional</em></span>
            <input v-model="newFlow.topic" placeholder="What this channel is for" />
          </label>
          <button type="submit" class="chat-primary-button" :disabled="newFlow.busy || !newFlow.name.trim()">
            {{ newFlow.busy ? 'Creating…' : 'Create channel' }}
          </button>
        </form>

        <form v-else-if="newFlow.mode === 'join'" class="mt-3" @submit.prevent="submitJoinChannel">
          <label class="chat-field">
            <span>Channel name</span>
            <div class="flex border border-rule bg-surface focus-within:border-accent">
              <span class="grid w-7 place-items-center text-[11px] text-ink-4">#</span>
              <input ref="newFlowInput" v-model="newFlow.name" class="border-0" placeholder="product" />
            </div>
          </label>
          <button type="submit" class="chat-primary-button" :disabled="newFlow.busy || !newFlow.name.trim()">
            {{ newFlow.busy ? 'Joining…' : 'Join channel' }}
          </button>
        </form>

        <form v-else class="mt-3" @submit.prevent="submitDirect">
          <label class="chat-field">
            <span>Find a person</span>
            <input ref="newFlowInput" v-model="newFlow.person" placeholder="Name or account" />
          </label>
          <div class="mt-2 max-h-52 overflow-y-auto border-y border-rule-light py-1">
            <button
              v-for="member in filteredMembers"
              :key="member.nick"
              type="button"
              class="flex h-9 w-full items-center gap-2 px-2 text-left hover:bg-chrome-high focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
              @click="openDirect(member.account || member.nick)"
            >
              <span
                class="size-1.5 shrink-0 rounded-full"
                :class="member.away ? 'bg-ink-4' : 'bg-add'"
                :title="member.away ? member.awayMessage || 'Away' : 'Available'"
                aria-hidden="true"
              />
              <span class="min-w-0 flex-1 truncate text-[10px] font-medium text-ink">{{ member.displayName }}</span>
              <span v-if="member.away" class="text-[8px] text-ink-4">away</span>
              <span class="truncate font-mono text-[8px] text-ink-4">{{ member.account || member.nick }}</span>
            </button>
            <p v-if="!filteredMembers.length" class="px-2 py-3 text-center text-[9px] text-ink-3">
              No known teammate matches. Enter their exact account below.
            </p>
          </div>
          <button type="submit" class="chat-primary-button" :disabled="newFlow.busy || !newFlow.person.trim()">
            {{ newFlow.busy ? 'Opening…' : `Message account “${newFlow.person.trim()}”` }}
          </button>
        </form>

        <p v-if="newFlow.error" class="mt-3 text-[10px] leading-relaxed text-rem" role="alert">
          {{ newFlow.error }}
        </p>
      </section>
    </div>
  </div>
</template>

<script setup>
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  reactive,
  ref,
  watch,
} from 'vue'
import {
  IconArrowBackUp,
  IconArrowLeft,
  IconArrowUp,
  IconDoorEnter,
  IconDownload,
  IconDots,
  IconExternalLink,
  IconFile,
  IconHash,
  IconLink,
  IconLoader2,
  IconMessages,
  IconMoodPlus,
  IconPaperclip,
  IconPencil,
  IconPhoto,
  IconPlugConnectedX,
  IconSearch,
  IconTrash,
  IconUser,
  IconX,
} from '@tabler/icons-vue'
import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import { useChatStore } from '../../stores/chat.js'
import { dropPoint, measureDropScale } from '../files/useFileDrop.js'
import { isTauriRuntime } from '../../shared/platform.js'

const props = defineProps({
  activity: { type: Object, required: true },
  active: { type: Boolean, default: false },
})

defineEmits(['openActivity'])

const chat = useChatStore()
const timeline = ref(null)
const composer = ref(null)
const searchInput = ref(null)
const setupName = ref(null)
const setupPassword = ref(null)
const newFlowDialog = ref(null)
const newFlowInput = ref(null)
const newFlowMenuFirst = ref(null)
const replyingId = ref('')
const openActionsId = ref('')
const actionsMode = ref('menu')
const deleteConfirmId = ref('')
const editingId = ref('')
const editDraft = ref('')
const editingBusy = ref(false)
const copiedMessageId = ref('')
const uploads = ref([])
const attachmentBusy = reactive({})
const dragActive = ref(false)
const newMarkerId = ref('')
const highlightedId = ref('')
const focusedMessageId = ref('')
const newBelow = ref(0)
const composerError = ref('')
const announcement = ref('')
const sending = ref(false)
const setup = reactive({
  endpoint: chat.config.endpoint,
  account: chat.config.account,
  displayName: chat.config.displayName,
  password: '',
  busy: false,
  error: '',
})
const newFlow = reactive({
  open: false,
  mode: 'menu',
  name: '',
  topic: '',
  person: '',
  error: '',
  busy: false,
})
const SEARCH_SCOPES = Object.freeze([
  { id: 'target', label: 'This chat' },
  { id: 'all', label: 'All chats' },
])
const QUICK_REACTIONS = Object.freeze(['👍', '❤️', '😂', '🎉', '👀'])
let searchTimer = null
let highlightTimer = null
let copiedTimer = null
let uploadClearTimer = null
let typingPauseTimer = null
let lastTypingSentAt = 0
let typingTarget = ''
let unlistenDrop = null
let dropScale = 1
let loadingOlder = false
let lastMarkedReadId = ''
let newFlowReturnFocus = null
let pendingRestoreTarget = ''

const messages = computed(() => chat.activeMessages)
const focusableMessageId = computed(() => (
  messages.value.some(message => message.id === focusedMessageId.value)
    ? focusedMessageId.value
    : messages.value.at(-1)?.id || ''
))
const messageById = computed(() => new Map(messages.value.map(message => [message.id, message])))
const replyingTo = computed(() => messageById.value.get(replyingId.value) || null)
const editDraftBytes = computed(() => new TextEncoder().encode(editDraft.value).length)
const canSaveEdit = computed(() => (
  Boolean(editDraft.value.trim())
    && editDraftBytes.value <= 350
    && editDraft.value !== messageById.value.get(editingId.value)?.body
))
const uploading = computed(() => uploads.value.some(upload => upload.state === 'uploading'))
const typingLabel = computed(() => {
  const names = chat.activeTypers
  if (!names.length) return ''
  if (names.length === 1) return `${names[0]} is typing…`
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`
  return `${names[0]} and ${names.length - 1} others are typing…`
})
const draft = computed({
  get: () => chat.drafts[chat.activeTarget] || '',
  set: value => {
    if (chat.activeTarget) chat.drafts[chat.activeTarget] = value
  },
})
const canSend = computed(
  () => chat.connected && Boolean(draft.value.trim()) && !sending.value,
)
const composerPlaceholder = computed(() => {
  const target = chat.activeRecord
  if (!target) return 'Message'
  return target.kind === 'channel'
    ? `Message ${target.id}`
    : `Message ${target.title || target.id}`
})
const connectionNotice = computed(() => ({
  connecting: 'Connecting to team chat. Cached messages remain available.',
  reconnecting: 'Connection interrupted. Cached messages and drafts are safe.',
  disconnected: 'Team chat is offline. Cached messages remain available.',
  error: 'Couldn’t connect to team chat.',
}[chat.status.state] || 'Team chat is unavailable.'))
const newFlowTitle = computed(() => ({
  menu: 'New chat',
  channel: 'New channel',
  join: 'Join channel',
  direct: 'Direct message',
}[newFlow.mode]))
const filteredMembers = computed(() => {
  const query = newFlow.person.trim().toLowerCase()
  return chat.members
    .filter(member => (
      member.account?.toLowerCase() !== chat.status.account?.toLowerCase()
        && member.nick?.toLowerCase() !== chat.status.account?.toLowerCase()
    ))
    .filter(member => (
      !query
        || member.displayName?.toLowerCase().includes(query)
        || member.account?.toLowerCase().includes(query)
        || member.nick?.toLowerCase().includes(query)
    ))
    .slice(0, 30)
})

watch(
  () => chat.config,
  value => Object.assign(setup, {
    endpoint: value.endpoint,
    account: value.account,
    displayName: value.displayName,
  }),
  { deep: true },
)

watch(
  () => chat.activeTarget,
  async (target, previous) => {
    if (previous && typingTarget === previous) void finishTyping(previous)
    if (previous && timeline.value) saveTimeline(previous)
    replyingId.value = ''
    openActionsId.value = ''
    editingId.value = ''
    deleteConfirmId.value = ''
    composerError.value = ''
    newBelow.value = 0
    lastMarkedReadId = ''
    const record = chat.targets.find(candidate => candidate.id === target)
    newMarkerId.value = record?.firstUnreadId || ''
    await nextTick()
    if (record?.firstUnreadId) {
      // The anchored load positions the viewport at the first unread
      // message; scrolling to the cached bottom here would mark it read.
      pendingRestoreTarget = ''
    } else if (chat.loadingByTarget[target] || !chat.activeMessages.length) {
      // History is still loading: restoring now would land at the top of an
      // empty timeline. Restore once the messages arrive.
      pendingRestoreTarget = target
    } else {
      restoreTimeline(target)
    }
    resizeComposer()
  },
)

watch(
  () => chat.activeMessages,
  async () => {
    if (!pendingRestoreTarget || pendingRestoreTarget !== chat.activeTarget) return
    pendingRestoreTarget = ''
    await nextTick()
    if (chat.focusMessageId || chat.windowedByTarget[chat.activeTarget]) return
    restoreTimeline(chat.activeTarget)
  },
)

watch(
  () => props.active,
  async active => {
    chat.setViewActive(active)
    if (!active) void finishTyping()
    if (!active || !chat.activeTarget) return
    const unread = chat.targets.find(
      target => target.id === chat.activeTarget,
    )?.firstUnreadId
    if (unread) {
      newMarkerId.value = unread
      await chat.selectTarget(chat.activeTarget, { messageId: unread })
      return
    }
    await nextTick()
    if (isAtBottom()) void markVisibleRead()
  },
)

watch(
  () => chat.focusMessageId,
  async messageId => {
    if (!messageId) return
    await nextTick()
    await jumpToMessage(messageId)
    chat.clearFocusMessage()
  },
)

watch(
  () => chat.latestLiveMessage,
  async latest => {
    if (
      !latest
      || latest.target !== chat.activeTarget
      || loadingOlder
      || !props.active
    ) return
    if (!latest.own) {
      const body = latest.deleted
        ? 'Message deleted'
        : latest.body || (latest.attachments?.length ? 'Shared a file' : 'New message')
      announcement.value = `${senderName(latest)}: ${singleLine(body)}`
    }
    // A windowed room shows history with a gap below; never auto-follow out
    // of it, just offer the jump control.
    const shouldFollow = !chat.windowedByTarget[chat.activeTarget] && isAtBottom()
    await nextTick()
    if (shouldFollow) {
      scrollToBottom()
      void markVisibleRead()
    } else {
      newBelow.value += 1
    }
  },
)

watch(
  () => messages.value.flatMap(message => (
    message.attachments || []
  )).map(attachment => `${attachment.id}:${attachment.localPath || ''}`).join('|'),
  () => {
    void ensureImagePreviews()
  },
)

watch(
  () => [chat.searchState.query, chat.searchState.scope],
  () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      if (chat.searchState.open) void chat.runSearch()
    }, 180)
  },
)

watch(
  () => chat.searchState.open,
  async open => {
    if (open) {
      await nextTick()
      searchInput.value?.focus()
    }
  },
)

watch(
  () => chat.newChatRequest,
  request => {
    if (!request) return
    openNewFlow(request.mode)
    chat.clearNewChatRequest()
  },
)

watch(
  () => newFlow.mode,
  async mode => {
    newFlow.error = ''
    if (mode === 'direct') await chat.refreshMembers()
    await nextTick()
    if (mode === 'menu') newFlowMenuFirst.value?.focus()
    else newFlowInput.value?.focus()
  },
)

onMounted(async () => {
  document.addEventListener('keydown', onGlobalKeydown, true)
  document.addEventListener('pointerdown', onDocumentPointerdown, true)
  await chat.initialize()
  chat.setViewActive(props.active)
  if (chat.activeTarget && !chat.activeMessages.length) {
    await chat.selectTarget(chat.activeTarget)
  }
  await nextTick()
  restoreTimeline(chat.activeTarget)
  await setupAttachmentDrop()
  void ensureImagePreviews()
})

onUnmounted(() => {
  document.removeEventListener('keydown', onGlobalKeydown, true)
  document.removeEventListener('pointerdown', onDocumentPointerdown, true)
  clearTimeout(searchTimer)
  clearTimeout(highlightTimer)
  clearTimeout(copiedTimer)
  clearTimeout(uploadClearTimer)
  clearTimeout(typingPauseTimer)
  void finishTyping()
  chat.setViewActive(false)
  unlistenDrop?.()
  unlistenDrop = null
  if (chat.activeTarget) saveTimeline(chat.activeTarget)
})

defineExpose({ focusEntry })

function focusEntry() {
  if (chat.status.state === 'needs_credentials') {
    setupPassword.value?.focus()
  } else if (chat.searchState.open) {
    searchInput.value?.focus()
  } else {
    composer.value?.focus()
  }
}

async function connect() {
  setup.error = ''
  setup.busy = true
  try {
    await chat.configure({
      endpoint: setup.endpoint.trim(),
      account: setup.account.trim(),
      displayName: setup.displayName.trim(),
      password: setup.password,
    })
    setup.password = ''
  } catch (cause) {
    setup.error = errorMessage(cause)
  } finally {
    setup.busy = false
  }
}

function onGlobalKeydown(event) {
  if (!props.active) return
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault()
    event.stopPropagation()
    chat.openSearch()
  }
}

function onEscape(event) {
  if (newFlow.open) {
    event.stopPropagation()
    closeNewFlow()
    return
  }
  if (replyingId.value) {
    event.stopPropagation()
    replyingId.value = ''
    return
  }
  if (editingId.value) {
    event.stopPropagation()
    cancelEdit()
    return
  }
  if (openActionsId.value) {
    event.stopPropagation()
    openActionsId.value = ''
    deleteConfirmId.value = ''
    return
  }
  if (chat.searchState.open) {
    event.stopPropagation()
    chat.closeSearch()
    return
  }
  if (chat.returnToSearch()) {
    event.stopPropagation()
    return
  }
}

function onDocumentPointerdown(event) {
  if (!openActionsId.value || event.target?.closest?.('[data-chat-actions]')) return
  openActionsId.value = ''
  deleteConfirmId.value = ''
}

function onNewFlowKeydown(event) {
  if (event.key !== 'Tab') return
  const targets = [...newFlowDialog.value.querySelectorAll(
    'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
  )]
  if (!targets.length) return
  const current = targets.indexOf(document.activeElement)
  const next = event.shiftKey
    ? (current <= 0 ? targets.at(-1) : targets[current - 1])
    : (current < 0 || current === targets.length - 1 ? targets[0] : targets[current + 1])
  event.preventDefault()
  next.focus()
}

function onComposerKeydown(event) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  void submitMessage()
}

function onComposerInput() {
  resizeComposer()
  clearTimeout(typingPauseTimer)
  if (!draft.value.trim()) {
    void finishTyping()
    return
  }
  const now = Date.now()
  if (!typingTarget || now - lastTypingSentAt > 2500) {
    typingTarget = chat.activeTarget
    lastTypingSentAt = now
    void chat.setTyping('active', typingTarget).catch(() => {})
  }
  const target = typingTarget
  typingPauseTimer = setTimeout(() => {
    if (typingTarget === target) {
      void chat.setTyping('pause', target).catch(() => {})
    }
  }, 3500)
}

async function finishTyping(target = typingTarget) {
  clearTimeout(typingPauseTimer)
  typingPauseTimer = null
  if (!target) return
  if (typingTarget === target) typingTarget = ''
  lastTypingSentAt = 0
  await chat.setTyping('done', target).catch(() => {})
}

async function submitMessage() {
  // Bind the send to the room visible at submit time: the user can switch
  // rooms while the send is in flight.
  const target = chat.activeTarget
  const text = draft.value
  if (!target || !text.trim() || !chat.connected || sending.value) return
  composerError.value = ''
  sending.value = true
  try {
    await finishTyping()
    await chat.send(text, replyingId.value || null, target)
    chat.drafts[target] = ''
    if (chat.activeTarget === target) {
      replyingId.value = ''
      await nextTick()
      resizeComposer()
      scrollToBottom()
      composer.value?.focus()
    }
  } catch (cause) {
    composerError.value = errorMessage(cause)
  } finally {
    sending.value = false
  }
}

async function pickAttachments() {
  if (!chat.connected || uploading.value) return
  try {
    const selected = await openFileDialog({
      multiple: true,
      directory: false,
      title: `Share files in ${chat.activeTarget}`,
    })
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : []
    await uploadPaths(paths)
  } catch (cause) {
    composerError.value = errorMessage(cause)
  }
}

async function uploadPaths(paths) {
  const target = chat.activeTarget
  for (const path of paths.filter(Boolean)) {
    const item = addUpload(pathName(path))
    try {
      await chat.uploadPath(path, target)
      finishUpload(item, 'sent')
    } catch (cause) {
      finishUpload(item, 'error', errorMessage(cause))
    }
  }
  scheduleUploadCleanup()
}

async function onComposerPaste(event) {
  const files = [...(event.clipboardData?.files || [])]
  if (!files.length || !chat.connected) return
  event.preventDefault()
  const target = chat.activeTarget
  for (const file of files) {
    const item = addUpload(file.name || 'Pasted image')
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      await chat.uploadBase64(
        file.name || `pasted-${Date.now()}.png`,
        file.type || 'application/octet-stream',
        bytesToBase64(bytes),
        target,
      )
      finishUpload(item, 'sent')
    } catch (cause) {
      finishUpload(item, 'error', errorMessage(cause))
    }
  }
  scheduleUploadCleanup()
}

function addUpload(name) {
  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name,
    state: 'uploading',
    error: '',
  }
  uploads.value = [...uploads.value, item]
  return item
}

function finishUpload(item, state, error = '') {
  item.state = state
  item.error = error
  uploads.value = [...uploads.value]
}

function scheduleUploadCleanup() {
  clearTimeout(uploadClearTimer)
  uploadClearTimer = setTimeout(() => {
    uploads.value = uploads.value.filter(upload => upload.state === 'error')
  }, 2200)
}

function bytesToBase64(bytes) {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 32_768))
  }
  return btoa(binary)
}

function pathName(path) {
  return String(path).split(/[\\/]/).filter(Boolean).at(-1) || 'Attachment'
}

async function openAttachment(attachment) {
  if (attachmentBusy[attachment.id]) return
  attachmentBusy[attachment.id] = true
  composerError.value = ''
  try {
    await chat.openAttachment(attachment)
  } catch (cause) {
    composerError.value = errorMessage(cause)
  } finally {
    delete attachmentBusy[attachment.id]
  }
}

async function ensureImagePreviews() {
  for (const message of messages.value) {
    for (const attachment of message.attachments || []) {
      if (
        !isPreviewableImage(attachment)
        || chat.attachmentPreviews[attachment.id]
        || attachmentBusy[attachment.id]
      ) continue
      attachmentBusy[attachment.id] = true
      try {
        await chat.previewAttachment(attachment)
      } catch {
        // The file card remains fully useful as a deliberate download.
      } finally {
        delete attachmentBusy[attachment.id]
      }
    }
  }
}

function isPreviewableImage(attachment) {
  return ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(attachment?.mime)
    && Number(attachment?.size || 0) <= 10 * 1024 * 1024
}

function attachmentType(attachment) {
  const subtype = String(attachment?.mime || '').split('/')[1] || 'file'
  return subtype.replace('jpeg', 'JPEG').replace('plain', 'text').toUpperCase()
}

function isAttachmentFallback(message) {
  if (message?.attachments?.length !== 1) return false
  return message.body === `📎 ${message.attachments[0].name}`
}

function formatBytes(value) {
  const bytes = Number(value || 0)
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

async function setupAttachmentDrop() {
  if (!isTauriRuntime()) return
  try {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview')
    unlistenDrop = await getCurrentWebview().onDragDropEvent(event => {
      void handleAttachmentDrag(event?.payload)
    })
  } catch (error) {
    console.warn('[chat] attachment drag and drop is unavailable:', error)
  }
}

async function handleAttachmentDrag(payload) {
  if (!payload) return
  if (payload.type === 'enter') dropScale = await measureDropScale()
  const { x, y } = dropPoint(payload.position, dropScale)
  const overChat = Boolean(
    props.active
      && chat.activeTarget
      && document.elementFromPoint(x, y)?.closest?.('[data-chat-activity]'),
  )
  if (payload.type === 'drop') {
    dragActive.value = false
    if (overChat) await uploadPaths(payload.paths || [])
  } else if (payload.type === 'enter' || payload.type === 'over') {
    dragActive.value = overChat
  } else {
    dragActive.value = false
  }
}

function resizeComposer() {
  const field = composer.value
  if (!field) return
  field.style.height = 'auto'
  field.style.height = `${Math.min(field.scrollHeight, 132)}px`
}

function beginReply(message) {
  if (message.deleted) return
  openActionsId.value = ''
  replyingId.value = message.id
  nextTick(() => composer.value?.focus())
}

function onMessageKeydown(event, message, index) {
  if (
    event.target !== event.currentTarget
    || event.altKey
    || event.ctrlKey
    || event.metaKey
    || event.shiftKey
  ) return
  if (event.key.toLowerCase() === 'r') {
    event.preventDefault()
    beginReply(message)
    return
  }
  const nextIndex = {
    ArrowUp: index - 1,
    ArrowDown: index + 1,
    Home: 0,
    End: messages.value.length - 1,
  }[event.key]
  if (nextIndex === undefined) return
  event.preventDefault()
  focusMessageAt(nextIndex)
}

function focusMessageAt(index) {
  const bounded = Math.max(0, Math.min(index, messages.value.length - 1))
  const message = messages.value[bounded]
  if (!message) return
  focusedMessageId.value = message.id
  nextTick(() => document.getElementById(`chat-message-${message.id}`)?.focus())
}

function toggleActions(messageId, mode) {
  if (openActionsId.value === messageId && actionsMode.value === mode) {
    openActionsId.value = ''
    deleteConfirmId.value = ''
    return
  }
  openActionsId.value = messageId
  actionsMode.value = mode
  deleteConfirmId.value = ''
}

async function toggleReaction(message, reaction) {
  try {
    await chat.react(message, reaction)
    openActionsId.value = ''
  } catch (cause) {
    composerError.value = errorMessage(cause)
  }
}

function beginEdit(message) {
  openActionsId.value = ''
  deleteConfirmId.value = ''
  editingId.value = message.id
  editDraft.value = message.body
  nextTick(() => {
    document.querySelector('[data-chat-edit-input]')?.focus()
  })
}

function cancelEdit() {
  editingId.value = ''
  editDraft.value = ''
  editingBusy.value = false
}

async function submitEdit(message) {
  if (!canSaveEdit.value || editingBusy.value) return
  editingBusy.value = true
  composerError.value = ''
  try {
    await chat.edit(message, editDraft.value)
    cancelEdit()
  } catch (cause) {
    composerError.value = errorMessage(cause)
    editingBusy.value = false
  }
}

async function deleteOwnMessage(message) {
  composerError.value = ''
  try {
    await chat.deleteMessage(message)
    openActionsId.value = ''
    deleteConfirmId.value = ''
  } catch (cause) {
    composerError.value = errorMessage(cause)
  }
}

async function copyMessageLink(message) {
  const link = messagePermalink(message.target, message.id)
  try {
    await navigator.clipboard.writeText(link)
    copiedMessageId.value = message.id
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => {
      copiedMessageId.value = ''
      openActionsId.value = ''
    }, 1200)
  } catch {
    composerError.value = 'Could not copy the message link.'
  }
}

async function openPermalink(link) {
  try {
    const parsed = new URL(link)
    if (parsed.protocol !== 'mimir:' || parsed.hostname !== 'chat') throw new Error()
    const [target, messageId] = parsed.pathname
      .split('/')
      .filter(Boolean)
      .map(decodeURIComponent)
    if (!target || !messageId) throw new Error()
    await chat.selectTarget(target, { messageId })
  } catch {
    composerError.value = 'That Mimir chat link is invalid or no longer cached.'
  }
}

function messagePermalink(target, messageId) {
  return `mimir://chat/${encodeURIComponent(target)}/${encodeURIComponent(messageId)}`
}

async function jumpToReply(messageId) {
  if (messageById.value.has(messageId)) {
    await jumpToMessage(messageId)
    return
  }
  try {
    await chat.selectTarget(chat.activeTarget, { messageId })
  } catch {
    composerError.value = 'Earlier message is unavailable in the local cache.'
  }
}

async function jumpToMessage(messageId) {
  const element = document.getElementById(`chat-message-${messageId}`)
  if (!element) return
  element.scrollIntoView({ block: 'center' })
  highlightedId.value = messageId
  clearTimeout(highlightTimer)
  highlightTimer = setTimeout(() => {
    highlightedId.value = ''
  }, 1600)
  await markVisibleRead()
}

async function loadOlder() {
  if (loadingOlder || !timeline.value) return
  loadingOlder = true
  const previousHeight = timeline.value.scrollHeight
  const previousTop = timeline.value.scrollTop
  try {
    await chat.loadOlder()
    await nextTick()
    timeline.value.scrollTop = previousTop + timeline.value.scrollHeight - previousHeight
  } finally {
    loadingOlder = false
  }
}

function onTimelineScroll() {
  if (!timeline.value) return
  if (timeline.value.scrollTop < 48 && !chat.olderComplete[chat.activeTarget]) {
    void loadOlder()
  }
  if (isAtBottom()) {
    // The bottom of a historical window is not the bottom of the room:
    // newer messages still exist below the loaded range.
    if (!chat.windowedByTarget[chat.activeTarget]) newBelow.value = 0
    void markVisibleRead()
  }
}

function isAtBottom() {
  const element = timeline.value
  if (!element) return true
  return element.scrollHeight - element.scrollTop - element.clientHeight < 56
}

function scrollToBottom() {
  if (chat.windowedByTarget[chat.activeTarget]) {
    void jumpToLatest()
    return
  }
  if (!timeline.value) return
  timeline.value.scrollTop = timeline.value.scrollHeight
  newBelow.value = 0
  void markVisibleRead()
}

async function jumpToLatest() {
  // Leave the historical window by reloading the newest page, then follow.
  const target = chat.activeTarget
  if (!target) return
  try {
    await chat.loadLatest(target)
  } catch {
    return
  }
  if (chat.activeTarget !== target) return
  await nextTick()
  if (!timeline.value) return
  timeline.value.scrollTop = timeline.value.scrollHeight
  newBelow.value = 0
  void markVisibleRead()
}

function saveTimeline(target) {
  if (!timeline.value || !target) return
  chat.saveScroll(target, {
    top: timeline.value.scrollTop,
    atBottom: isAtBottom(),
  })
}

function restoreTimeline(target) {
  if (!timeline.value || !target) return
  const saved = chat.scrollByTarget[target]
  if (saved && !saved.atBottom) {
    timeline.value.scrollTop = saved.top
  } else {
    scrollToBottom()
  }
}

async function markVisibleRead() {
  // Only a visible, focused, bottom-following room is marked read; an
  // unfocused window must keep the unread dot for arriving messages.
  if (!props.active || !document.hasFocus() || !isAtBottom() || !messages.value.length) return
  const target = chat.activeTarget
  const messageId = messages.value.at(-1).id
  if (!target || lastMarkedReadId === messageId) return
  lastMarkedReadId = messageId
  try {
    await chat.markRead(messageId, target)
  } catch {
    lastMarkedReadId = ''
  }
}

function onWindowFocus() {
  if (isAtBottom()) void markVisibleRead()
}

function groupStart(index) {
  if (index === 0 || showsDay(index)) return true
  const current = messages.value[index]
  const previous = messages.value[index - 1]
  return current.senderNick !== previous.senderNick
    || current.agentLabel !== previous.agentLabel
    || Date.parse(current.serverTime) - Date.parse(previous.serverTime) > 5 * 60_000
}

function showsDay(index) {
  if (index === 0) return true
  return dateKey(messages.value[index].serverTime) !== dateKey(messages.value[index - 1].serverTime)
}

function senderName(message) {
  if (!message) return ''
  if (message.agentLabel) return titleCase(message.agentLabel)
  const key = (message.senderAccount || message.senderNick || '').toLowerCase()
  return chat.members.find(member => (
    member.account?.toLowerCase() === key || member.nick?.toLowerCase() === key
  ))?.displayName || message.senderNick
}

function messageBlocks(body) {
  return String(body || '').split('```').map((text, index) => ({
    code: index % 2 === 1,
    text: index % 2 === 1 ? text.replace(/^[a-z0-9_-]+\n/i, '') : text,
  })).filter(block => block.text)
}

function textParts(text) {
  const parts = []
  const pattern = /(?:https?:\/\/[^\s<>()]+|mimir:\/\/chat\/[^\s<>()]+)/gi
  let index = 0
  for (const match of String(text).matchAll(pattern)) {
    if (match.index > index) parts.push({ text: text.slice(index, match.index), url: false })
    parts.push({
      text: match[0],
      url: match[0].toLowerCase().startsWith('http'),
      chatLink: match[0].toLowerCase().startsWith('mimir://chat/'),
    })
    index = match.index + match[0].length
  }
  if (index < text.length) parts.push({ text: text.slice(index), url: false })
  return parts
}

function messageAriaLabel(message) {
  const body = message.deleted ? 'Message deleted' : message.body
  const edited = message.editedAt ? ', edited' : ''
  return `${senderName(message)}, ${exactDate(message.serverTime)}${edited}: ${body}`
}

function singleLine(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > 90 ? `${text.slice(0, 87)}…` : text
}

function timeLabel(value) {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function dayLabel(value) {
  const date = new Date(value)
  const today = dateKey(new Date())
  const yesterday = dateKey(new Date(Date.now() - 86_400_000))
  if (dateKey(date) === today) return 'Today'
  if (dateKey(date) === yesterday) return 'Yesterday'
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)
}

function compactDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function longDate(value) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date(value))
}

function exactDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function dateKey(value) {
  const date = value instanceof Date ? value : new Date(value)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function titleCase(value) {
  const text = String(value || '')
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text
}

function openNewFlow(mode = 'menu') {
  newFlowReturnFocus = document.activeElement
  Object.assign(newFlow, {
    open: true,
    mode,
    name: '',
    topic: '',
    person: '',
    error: '',
    busy: false,
  })
  nextTick(() => {
    if (mode === 'menu') newFlowDialog.value?.querySelector('button')?.focus()
    else newFlowInput.value?.focus()
  })
}

function closeNewFlow() {
  newFlow.open = false
  newFlow.error = ''
  nextTick(() => {
    if (newFlowReturnFocus?.isConnected) newFlowReturnFocus.focus()
    else composer.value?.focus()
    newFlowReturnFocus = null
  })
}

async function prepareDirect() {
  newFlow.mode = 'direct'
}

async function submitNewChannel() {
  await runNewFlow(() => chat.createChannel(newFlow.name, newFlow.topic))
}

async function submitJoinChannel() {
  await runNewFlow(() => chat.joinChannel(newFlow.name))
}

async function submitDirect() {
  await openDirect(newFlow.person)
}

async function openDirect(account) {
  await runNewFlow(() => chat.openDirect(account))
}

async function runNewFlow(action) {
  newFlow.error = ''
  newFlow.busy = true
  try {
    await action()
    closeNewFlow()
  } catch (cause) {
    newFlow.error = errorMessage(cause)
  } finally {
    newFlow.busy = false
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Chat action failed.')
}
</script>

<style scoped>
.chat-timeline {
  overflow-anchor: none;
  scrollbar-gutter: stable;
}

.chat-message {
  transition: background-color 140ms ease;
}

.chat-message:hover {
  background: var(--color-chrome-high);
}

.chat-message:focus-visible {
  outline: 1px solid var(--color-accent);
  outline-offset: -1px;
}

.chat-message-actions {
  opacity: 0;
  pointer-events: none;
}

.chat-message:hover .chat-message-actions,
.chat-message:focus-within .chat-message-actions {
  opacity: 1;
  pointer-events: auto;
}

.chat-message-action {
  display: grid;
  width: 1.75rem;
  height: 1.75rem;
  place-items: center;
  color: var(--color-ink-4);
}

.chat-message-action:hover,
.chat-message-action:focus-visible {
  outline: none;
  background: var(--color-chrome);
  color: var(--color-ink);
}

.chat-message-action:focus-visible {
  box-shadow: inset 0 0 0 1px var(--color-accent);
}

.chat-action-menu-item {
  display: flex;
  width: 100%;
  height: 1.875rem;
  align-items: center;
  gap: 0.5rem;
  padding: 0 0.5rem;
  text-align: left;
  font-size: 9px;
  color: var(--color-ink-2);
}

.chat-action-menu-item:hover,
.chat-action-menu-item:focus-visible {
  outline: none;
  background: var(--color-chrome-high);
  color: var(--color-ink);
}

.chat-field {
  display: block;
}

.chat-field > span {
  display: flex;
  justify-content: space-between;
  margin-bottom: 0.25rem;
  font-family: var(--font-mono);
  font-size: 8px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-ink-3);
}

.chat-field em {
  font-style: normal;
  color: var(--color-ink-4);
}

.chat-field input {
  width: 100%;
  height: 2rem;
  border: 1px solid var(--color-rule);
  background: var(--color-surface);
  padding: 0 0.5rem;
  font-size: 11px;
  color: var(--color-ink);
  outline: none;
}

.chat-field input:focus {
  border-color: var(--color-accent);
}

.chat-field div input {
  height: 1.875rem;
}

.new-chat-choice {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem;
  text-align: left;
  color: var(--color-ink-2);
}

.new-chat-choice:hover,
.new-chat-choice:focus-visible {
  outline: none;
  background: var(--color-chrome-high);
  color: var(--color-ink);
}

.new-chat-choice span {
  display: grid;
  gap: 0.125rem;
}

.new-chat-choice strong {
  font-size: 11px;
  font-weight: 600;
}

.new-chat-choice small {
  font-size: 9px;
  color: var(--color-ink-3);
}

.chat-primary-button {
  height: 2rem;
  margin-top: 1rem;
  padding: 0 0.75rem;
  background: var(--color-accent);
  color: var(--color-accent-ink);
  font-size: 10px;
  font-weight: 600;
}

.chat-primary-button:hover:not(:disabled) {
  background: var(--color-accent-2);
}

.chat-primary-button:focus-visible {
  outline: 1px solid var(--color-accent);
  outline-offset: 2px;
}

.chat-primary-button:disabled {
  opacity: 0.35;
}

@media (prefers-reduced-motion: reduce) {
  .chat-message {
    transition: none;
  }
}
</style>
