<template>
    <div
        ref="stripEl"
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
            <button
                v-for="(tab, i) in tabs"
                :key="tab.id"
                class="file-tab no-drag min-w-[80px] h-[28px] flex items-center gap-1 px-2 rounded-t-[5px] select-none whitespace-nowrap overflow-hidden font-mono text-[11.5px] relative"
                :class="[
                    activeTab === i ? 'tab-active' : 'tab-inactive',
                    dragState.active && dragState.fromIndex === i ? 'tab-dragging' : '',
                    dragState.dropTarget === i ? 'tab-drop-gap' : '',
                    arrivedTabIndex === i ? 'tab-arrived' : '',
                    tab.type === 'review' ? 'tab-review' : '',
                ]"
                @pointerdown="onPointerDown(i, $event)"
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
                <span
                    v-if="tabs.length > 1"
                    class="tab-close"
                    @click.stop="$emit('close-tab', i)"
                    >&times;</span
                >
            </button>

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
const TEAR_OFF_DISTANCE = 40;

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
    "tab-drag-out",
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
                    behavior: "smooth",
                    block: "nearest",
                    inline: "nearest",
                });
            }
        });
    },
);

function getTabButtons() {
    if (!stripEl.value) return [];
    return Array.from(stripEl.value.querySelectorAll(".file-tab"));
}

/* ── Ghost ── */

function showGhost(tabEl, x, y) {
    if (!ghostEl) {
        ghostEl = tabEl.cloneNode(true);
        ghostEl.className = "tab-drag-ghost floating";
        ghostEl.querySelectorAll(".tab-close").forEach((el) => el.remove());
        document.body.appendChild(ghostEl);
    }
    ghostEl.style.left = `${x - ghostEl.offsetWidth / 2}px`;
    ghostEl.style.top = `${y - ghostEl.offsetHeight / 2}px`;
}

function snapGhost(tabEl, targetBtn) {
    if (!ghostEl) {
        ghostEl = tabEl.cloneNode(true);
        ghostEl.className = "tab-drag-ghost snapped";
        ghostEl.querySelectorAll(".tab-close").forEach((el) => el.remove());
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
        ghostEl.querySelectorAll(".tab-close").forEach((el) => el.remove());
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

function floatGhost() {
    if (ghostEl && !ghostEl.classList.contains("floating")) {
        ghostEl.classList.remove("snapped");
        ghostEl.classList.add("floating");
    }
}

function removeGhost() {
    if (ghostEl) {
        ghostEl.remove();
        ghostEl = null;
    }
}

/* ── Native ghost (outside window) ── */

let nativeGhost = null;
let nativeGhostReady = false;
let ghostOffsetX = 0;
let ghostOffsetY = 0;

async function showNativeGhost(tabName, screenX, screenY) {
    if (!window.__TAURI_INTERNALS__) return;
    if (nativeGhost) {
        moveNativeGhost(screenX, screenY);
        return;
    }
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        const [osX, osY] = await invoke("get_cursor_position", {
            screenX,
            screenY,
        });
        ghostOffsetX = osX - screenX;
        ghostOffsetY = osY - screenY;

        localStorage.setItem("shoulders:ghost-text", tabName);
        const { WebviewWindow } = await import(
            "@tauri-apps/api/webviewWindow"
        );
        nativeGhost = new WebviewWindow("tab-ghost", {
            url: "/?view=ghost",
            width: 160,
            height: 30,
            x: osX - 60,
            y: osY - 15,
            decorations: false,
            transparent: true,
            alwaysOnTop: true,
            skipTaskbar: true,
            shadow: false,
            resizable: false,
            focus: false,
            visible: true,
        });
        nativeGhost.once("tauri://created", () => {
            nativeGhostReady = true;
        });
        nativeGhost.once("tauri://error", () => {
            nativeGhost = null;
        });
    } catch {
        nativeGhost = null;
    }
}

async function moveNativeGhost(screenX, screenY) {
    if (!nativeGhost || !nativeGhostReady) return;
    try {
        const { LogicalPosition } = await import("@tauri-apps/api/dpi");
        await nativeGhost.setPosition(
            new LogicalPosition(
                screenX + ghostOffsetX - 60,
                screenY + ghostOffsetY - 15,
            ),
        );
    } catch {}
}

async function hideNativeGhost() {
    if (!nativeGhost) return;
    try {
        await nativeGhost.close();
    } catch {}
    nativeGhost = null;
    nativeGhostReady = false;
}

/* ── Pointer handlers ── */

function onPointerDown(index, e) {
    if (e.button !== 0) return;
    if (e.target.closest(".tab-close")) return;
    if (props.tabs[index]?.type === "review") {
        emit("select-tab", index);
        return;
    }

    const tabEl = getTabButtons()[index];
    dragTabWidth.value = tabEl ? tabEl.offsetWidth : 80;
    dragState.fromIndex = index;
    dragState.dropTarget = -1;
    dragState.active = false;
    startX = e.clientX;
    startY = e.clientY;

    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("keydown", onKeyDown);
}

function onPointerMove(e) {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (!dragState.active) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD)
            return;
        dragState.active = true;
        document.body.style.cursor = "grabbing";
    }

    const tabEl = getTabButtons()[dragState.fromIndex];
    if (!tabEl) return;

    const stripRect = stripEl.value?.getBoundingClientRect();
    if (!stripRect) return;

    const outsideStrip =
        e.clientY < stripRect.top - TEAR_OFF_DISTANCE ||
        e.clientY > stripRect.bottom + TEAR_OFF_DISTANCE;

    if (outsideStrip) {
        dragState.dropTarget = -1;
        floatGhost();
        showGhost(tabEl, e.clientX, e.clientY);
        const tabName = props.tabs[dragState.fromIndex]?.name || "Tab";
        showNativeGhost(tabName, e.screenX, e.screenY);
        return;
    }

    hideNativeGhost();

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

function onPointerUp(e) {
    removeListeners();
    removeGhost();

    if (!dragState.active) {
        const idx = dragState.fromIndex;
        resetDrag();
        emit("select-tab", idx);
        return;
    }

    const from = dragState.fromIndex;

    const stripRect = stripEl.value?.getBoundingClientRect();
    const outsideStrip =
        !stripRect ||
        e.clientY < stripRect.top - TEAR_OFF_DISTANCE ||
        e.clientY > stripRect.bottom + TEAR_OFF_DISTANCE;

    if (outsideStrip) {
        resetDrag();
        emit("tab-drag-out", from, e.screenX, e.screenY);
        return;
    }

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
    if (e.key === "Escape" && dragState.active) {
        e.preventDefault();
        removeListeners();
        resetDrag();
    }
}

function removeListeners() {
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    document.removeEventListener("keydown", onKeyDown);
}

function resetDrag() {
    dragState.fromIndex = -1;
    dragState.dropTarget = -1;
    dragState.active = false;
    document.body.style.cursor = "";
    removeGhost();
    hideNativeGhost();
}

onUnmounted(() => {
    removeListeners();
    document.body.style.cursor = "";
    removeGhost();
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
.file-tab {
    flex-grow: 1;
    flex-shrink: 1;
    flex-basis: 0;
    max-width: 172px;
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
.file-tab:has(+ .tab-active)::after,
.file-tab:hover::after,
.file-tab:has(+ .file-tab:hover)::after {
    opacity: 0;
}

/* Tab close button — child selector + hover cascade */
.tab-close {
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

.file-tab:hover .tab-close,
.tab-active .tab-close {
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

.tab-drag-ghost.floating {
    padding: 4px 12px;
    border-radius: 6px;
    background: var(--color-surface, #fff);
    border: 1px solid var(--color-rule-light, #ddd);
    box-shadow:
        0 8px 24px rgba(0, 0, 0, 0.22),
        0 2px 6px rgba(0, 0, 0, 0.1);
    opacity: 0.92;
    transform: scale(1.04);
    backdrop-filter: blur(4px);
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
