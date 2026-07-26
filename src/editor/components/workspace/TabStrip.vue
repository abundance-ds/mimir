<template>
    <div
        ref="stripEl"
        role="tablist"
        aria-label="Open editor tabs"
        class="relative flex items-end flex-1 min-w-0 gap-0 whitespace-nowrap mt-auto"
        :style="dragState.active ? { '--drag-tab-w': dragTabWidth + 'px' } : {}"
    >
        <TransitionGroup
            ref="scrollRef"
            :name="dragState.active ? '' : 'tabs'"
            @before-leave="onTabBeforeLeave"
            @wheel="onTabWheel"
            tag="div"
            class="tab-scroll flex-1 min-w-0 flex items-end gap-0 overflow-x-auto overflow-y-hidden"
        >
            <div
                v-for="(tab, i) in tabs"
                :key="tab.id"
                class="file-tab-wrap no-drag min-w-[80px] h-[28px] relative"
                :class="[
                    dragState.active && dragState.fromIndex === i ? 'tab-dragging' : '',
                    dragState.dropTarget === i ? 'tab-drop-gap' : '',
                    arrivedTabIndex === i ? 'tab-arrived' : '',
                ]"
            >
              <button
                class="file-tab w-full h-full flex items-center gap-1 pl-2 pr-7 rounded-t-[5px] select-none whitespace-nowrap overflow-hidden font-mono text-[11.5px] relative"
                :class="[
                    activeTab === i ? 'tab-active' : 'tab-inactive',
                    tab.type === 'review' ? 'tab-review' : '',
                    tab.preview ? 'italic' : '',
                ]"
                role="tab"
                :aria-selected="activeTab === i"
                :tabindex="activeTab === i ? 0 : -1"
                @pointerdown="onPointerDown(i, $event)"
                @keydown.left.prevent.stop="selectKeyboardTab(i, -1)"
                @keydown.right.prevent.stop="selectKeyboardTab(i, 1)"
                @keydown.home.prevent.stop="selectKeyboardTab(i, -i)"
                @keydown.end.prevent.stop="selectKeyboardTab(i, tabs.length - 1 - i)"
                @keydown.enter.prevent.stop="selectKeyboardTab(i, 0)"
                @keydown.space.prevent.stop="selectKeyboardTab(i, 0)"
              >
                <span
                    class="flex-1 min-w-0 overflow-hidden text-ellipsis"
                    >{{ tab.name }}</span
                >
                <span
                    v-if="tab.dirty"
                    class="w-[5px] h-[5px] rounded-full shrink-0"
                    :class="
                        tab.saveTone === 'failed' ? 'bg-rem' : 'bg-accent'
                    "
                    :title="
                        tab.saveTone === 'failed'
                            ? 'Save failed'
                            : 'Unsaved changes'
                    "
                ></span>
              </button>
              <button
                  class="tab-close"
                  :aria-label="`Close ${tab.name}`"
                  title="Close tab"
                  @click.stop="$emit('close-tab', i)"
              >&times;</button>
            </div>

            <button
                key="__add__"
                class="shrink-0 no-drag w-4.5 h-4.5 flex items-center justify-center rounded-sm font-mono text-[20px] leading-none text-ink-3 hover:text-ink-2 ml-3 my-auto"
                aria-label="New tab"
                title="New tab"
                @click="$emit('add-tab')"
            >
                <IconPlus></IconPlus>
            </button>
        </TransitionGroup>
    </div>
</template>

<script setup>
import { IconPlus } from "@tabler/icons-vue";
import { ref, reactive, computed, watch, nextTick, onUnmounted } from "vue";

const DRAG_THRESHOLD = 5;

const props = defineProps({
    tabs: { type: Array, required: true },
    activeTab: { type: Number, default: 0 },
    arrivedTabIndex: { type: Number, default: -1 },
});

const emit = defineEmits([
    "select-tab",
    "close-tab",
    "add-tab",
    "reorder-tab",
]);

const stripEl = ref(null);
const scrollRef = ref(null);

const dragState = reactive({
    fromIndex: -1,
    dropTarget: -1,
    active: false,
});

let startX = 0;
let startY = 0;
let ghostEl = null;
const dragTabWidth = ref(0);
let bodyAffordanceActive = false;
let previousBodyCursor = "";
let previousBodyUserSelect = "";

function getScrollEl() {
    const r = scrollRef.value;
    return r?.$el ?? r;
}

function onTabWheel(e) {
    const el = getScrollEl();
    if (!el || el.scrollWidth <= el.clientWidth) return;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    el.scrollLeft += e.deltaY;
}

function onTabBeforeLeave(el) {
    if (dragState.active) return;
    el.style.width = el.offsetWidth + "px";
    el.style.flex = "none";
    el.style.overflow = "hidden";
}

watch(
    () => props.activeTab,
    () => {
        nextTick(() => {
            const buttons = getTabButtons();
            const active = buttons[props.activeTab];
            if (active && getScrollEl()) {
                active.scrollIntoView({
                    behavior: "auto",
                    block: "nearest",
                    inline: "nearest",
                });
            }
        });
    },
);

function getTabButtons() {
    if (!stripEl.value) return [];
    return Array.from(stripEl.value.querySelectorAll("button.file-tab"));
}

/* ── Ghost ── */

function snapGhost(tabEl, targetBtn) {
    if (!ghostEl) {
        ghostEl = tabEl.cloneNode(true);
        ghostEl.className = "tab-drag-ghost snapped";
        document.body.appendChild(ghostEl);
    }
    if (!ghostEl.classList.contains("snapped")) {
        ghostEl.classList.remove("floating");
        ghostEl.classList.add("snapped");
    }
    const r = targetBtn.getBoundingClientRect();
    ghostEl.style.left = `${r.left - dragTabWidth.value}px`;
    ghostEl.style.top = `${r.top}px`;
}

function snapGhostAfterLast(tabEl, lastBtn) {
    if (!ghostEl) {
        ghostEl = tabEl.cloneNode(true);
        ghostEl.className = "tab-drag-ghost snapped";
        document.body.appendChild(ghostEl);
    }
    if (!ghostEl.classList.contains("snapped")) {
        ghostEl.classList.remove("floating");
        ghostEl.classList.add("snapped");
    }
    const r = lastBtn.getBoundingClientRect();
    ghostEl.style.left = `${r.right + 2}px`;
    ghostEl.style.top = `${r.top}px`;
}

function removeGhost() {
    if (ghostEl) {
        ghostEl.remove();
        ghostEl = null;
    }
}

/* ── Pointer handlers ── */


function onPointerDown(index, e) {
    if (e.button !== 0) return;
    if (props.tabs[index]?.type === "review") {
        emit("select-tab", index);
        return;
    }
    cancelDrag();

    const tabEl = getTabButtons()[index];
    dragTabWidth.value = tabEl ? tabEl.offsetWidth : 80;
    dragState.fromIndex = index;
    dragState.dropTarget = -1;
    dragState.active = false;
    startX = e.clientX;
    startY = e.clientY;

    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerCancel);
    document.addEventListener("keydown", onKeyDown);
}

function onPointerMove(e) {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (!dragState.active) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD)
            return;
        dragState.active = true;
        beginBodyAffordance();
    }

    const tabEl = getTabButtons()[dragState.fromIndex];
    if (!tabEl) return;

    const buttons = getTabButtons();
    let target = -1;

    for (let i = 0; i < buttons.length; i++) {
        const rect = buttons[i].getBoundingClientRect();
        const mid = rect.left + rect.width / 2;
        if (e.clientX < mid) {
            target = i;
            break;
        }
    }
    if (target === -1) target = buttons.length;

    // Always snap ghost to where the tab would land
    if (target === dragState.fromIndex || target === dragState.fromIndex + 1) {
        dragState.dropTarget = dragState.fromIndex;
    } else {
        dragState.dropTarget = target;
    }

    const snapTarget = buttons[dragState.dropTarget];
    if (snapTarget) {
        snapGhost(tabEl, snapTarget);
    } else if (buttons.length > 0) {
        snapGhostAfterLast(tabEl, buttons[buttons.length - 1]);
    }
}

function onPointerUp() {
    removeListeners();
    removeGhost();

    if (!dragState.active) {
        const idx = dragState.fromIndex;
        resetDrag();
        emit("select-tab", idx);
        return;
    }

    const from = dragState.fromIndex;

    if (dragState.dropTarget >= 0) {
        let to = dragState.dropTarget;
        if (from < to) to -= 1;
        resetDrag();
        if (from !== to) {
            emit("reorder-tab", from, to);
        }
        return;
    }

    resetDrag();
}

function onKeyDown(e) {
    if (e.key === "Escape" && dragState.fromIndex >= 0) {
        e.preventDefault();
        cancelDrag();
    }
}

function onPointerCancel() {
    cancelDrag();
}

function selectKeyboardTab(index, delta) {
    if (!props.tabs.length) return;
    const next = (index + delta + props.tabs.length) % props.tabs.length;
    emit("select-tab", next);
    nextTick(() => getTabButtons()[next]?.focus());
}

function removeListeners() {
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    document.removeEventListener("pointercancel", onPointerCancel);
    document.removeEventListener("keydown", onKeyDown);
}

function beginBodyAffordance() {
    if (!document.body || bodyAffordanceActive) return;
    previousBodyCursor = document.body.style.cursor;
    previousBodyUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    bodyAffordanceActive = true;
}

function endBodyAffordance() {
    if (!document.body || !bodyAffordanceActive) return;
    document.body.style.cursor = previousBodyCursor;
    document.body.style.userSelect = previousBodyUserSelect;
    bodyAffordanceActive = false;
}

function cancelDrag() {
    removeListeners();
    resetDrag();
}

function resetDrag() {
    dragState.fromIndex = -1;
    dragState.dropTarget = -1;
    dragState.active = false;
    endBodyAffordance();
    removeGhost();
}

onUnmounted(() => {
    cancelDrag();
});
</script>

<style scoped>
/* Scrollbar hiding — Tailwind cannot express this */
.tab-scroll {
    scrollbar-width: none;
}

.tab-scroll::-webkit-scrollbar {
    display: none;
}

/* TransitionGroup: enter */
.tabs-enter-active {
    transition:
        opacity 150ms ease,
        transform 150ms ease;
}

.tabs-enter-from {
    opacity: 0;
    transform: translateX(-8px);
}

/* TransitionGroup: leave (width-collapse) */
.tabs-leave-active {
    transition:
        width 200ms ease,
        opacity 150ms ease,
        padding 200ms ease;
}

.tabs-leave-to {
    width: 0 !important;
    padding-left: 0 !important;
    padding-right: 0 !important;
    opacity: 0;
}

/* Tab sizing: equal share of available space, clamped 80–172px */
.file-tab-wrap {
    flex-grow: 1;
    flex-shrink: 1;
    flex-basis: 0;
    max-width: 172px;
}

.file-tab {
    min-width: 0;
}

/* Tab separator line — pseudo-element + :has() require vanilla CSS */
.file-tab::after {
    content: "";
    position: absolute;
    right: 0;
    top: 20%;
    height: 60%;
    width: 1px;
    background: var(--color-rule-light);
}

.file-tab.tab-active::after,
.file-tab:hover::after,
.file-tab-wrap:has(+ .file-tab-wrap .tab-active) .file-tab::after,
.file-tab-wrap:has(+ .file-tab-wrap:hover) .file-tab::after {
    opacity: 0;
}

/* Tab close button — child selector + hover cascade */
.tab-close {
    position: absolute;
    z-index: 1;
    right: 6px;
    top: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    margin-left: 2px;
    border-radius: 3px;
    font-size: 14px;
    line-height: 1;
    color: var(--color-ink-3);
    flex-shrink: 0;
    opacity: 0;
}

.file-tab-wrap:hover .tab-close,
.file-tab-wrap:focus-within .tab-close,
.file-tab-wrap:has(.tab-active) .tab-close {
    opacity: 1;
}

.tab-close:hover {
    background: var(--color-chrome-high);
    color: var(--color-ink);
}

/* Tab states */
.tab-inactive {
    color: var(--color-ink-3);
    background: transparent;
}

.tab-inactive:hover {
    color: var(--color-ink-2);
    background: var(--color-chrome-mid);
}

.tab-active {
    color: var(--color-ink);
    font-weight: 600;
    background: var(--color-surface);
}

/* Drag states */
.tab-dragging {
    flex: 0 0 0 !important;
    width: 0 !important;
    min-width: 0 !important;
    padding: 0 !important;
    overflow: hidden !important;
    opacity: 0 !important;
    pointer-events: none;
}

.tab-drop-gap {
    margin-left: var(--drag-tab-w, 80px);
}

/* Arrival pulse */
.tab-arrived {
    animation: tab-arrive-pulse 600ms ease;
}

@keyframes tab-arrive-pulse {
    0%,
    15% {
        box-shadow: 0 0 0 3px
            color-mix(in srgb, var(--color-accent) 25%, transparent);
    }
    100% {
        box-shadow: 0 0 0 0 transparent;
    }
}

/* Review tab */
.tab-review {
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0;
}
.tab-review.tab-active {
    font-weight: 600;
    color: var(--color-accent);
}
</style>

<style>
/* Global: drag ghost (rendered outside component tree) */
.tab-drag-ghost {
    position: fixed;
    z-index: 99999;
    pointer-events: none;
    font-size: 10.5px;
    font-family: var(--font-mono);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.tab-drag-ghost.snapped {
    padding: 4px 8px;
    border-radius: 5px 5px 0 0;
    background: var(--color-chrome-mid, #f0f0f0);
    border: 1px solid var(--color-rule-light, #ddd);
    border-bottom-color: transparent;
    box-shadow: none;
    opacity: 0.55;
    transform: none;
}
</style>
