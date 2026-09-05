<template>
    <div
        ref="headerRef"
        data-tauri-drag-region="deep"
        data-editor-header
        class="pane-header relative z-40 gap-0 px-[14px] whitespace-nowrap overflow-visible drag-region"
        @keydown.esc="closeMenu"
    >
        <!-- Left: traffic-light spacer -->
        <div
            v-if="!hideSidebar"
            data-tauri-drag-region="deep"
            class="relative w-[56px] shrink-0 self-stretch"
            aria-hidden="true"
        ></div>

        <!-- Gap between traffic lights and tabs -->
        <div v-if="!hideSidebar" data-tauri-drag-region class="w-7 shrink-0 self-stretch"></div>

        <div
            v-if="embedded && activityRailed"
            data-editor-restore-cluster
            class="no-drag mr-1 flex shrink-0 items-center border-r border-rule pr-1"
        >
            <button
                v-if="sidebarRailed && activityRailed"
                type="button"
                data-editor-action="restore-sidebar"
                class="sidebar-toggle no-drag"
                title="Restore sidebar"
                aria-label="Restore sidebar"
                @click="restorePane('sidebar')"
            >
                <IconArrowBarRight :size="15" :stroke-width="1.9" />
            </button>
            <button
                v-if="activityRailed"
                type="button"
                data-editor-action="restore-activity"
                class="sidebar-toggle no-drag"
                title="Restore activity"
                aria-label="Restore activity"
                @click="restorePane('activity')"
            >
                <IconLayoutSidebarLeftExpand :size="17" />
            </button>
        </div>

        <!-- File tabs -->
        <TabStrip
            data-editor-tabs-region
            :tabs="tabs"
            :activeTab="activeTab"
            :arrivedTabIndex="arrivedTabIndex"
            @select-tab="$emit('select-tab', $event)"
            @close-tab="$emit('close-tab', $event)"
            @discard-tab="$emit('discard-tab', $event)"
            @add-tab="$emit('add-tab')"
            @reorder-tab="(from, to) => $emit('reorder-tab', from, to)"
        />

        <!-- App menus (Windows/Linux only) -->
        <nav
            v-if="showAppMenus && !embedded"
            class="app-menu no-drag"
            aria-label="Application menu"
        >
            <div class="menu-group">
                <button
                    class="menu-trigger"
                    :class="{ 'is-open': openMenu === 'file' }"
                    aria-haspopup="menu"
                    :aria-expanded="openMenu === 'file'"
                    @click="toggleMenu('file')"
                >
                    <span>File</span>
                    <IconChevronDown :size="11" class="menu-chevron" />
                </button>

                <div
                    v-if="openMenu === 'file'"
                    class="header-menu file-menu"
                    role="menu"
                >
                    <button
                        class="menu-item"
                        role="menuitem"
                        @click="runFileAction('new-file')"
                    >
                        <IconFilePlus :size="14" />
                        <span class="menu-label">New File</span>
                        <kbd>{{ shortcut("N") }}</kbd>
                    </button>
                    <button
                        class="menu-item"
                        role="menuitem"
                        @click="runFileAction('open-file')"
                    >
                        <IconFolderOpen :size="14" />
                        <span class="menu-label">Open File</span>
                        <kbd>{{ shortcut("O") }}</kbd>
                    </button>

                    <div class="menu-divider" />
                    <div class="menu-section">
                        <IconHistory :size="13" />
                        <span>Open Recent</span>
                    </div>
                    <button
                        v-for="path in clippedRecentFiles"
                        :key="path"
                        class="menu-item recent-item"
                        role="menuitem"
                        :title="path"
                        @click="openRecent(path)"
                    >
                        <IconFileText :size="14" />
                        <span class="recent-copy">
                            <span class="recent-name">{{
                                basename(path)
                            }}</span>
                            <span class="recent-path">{{ dirname(path) }}</span>
                        </span>
                    </button>
                    <button
                        v-if="clippedRecentFiles.length === 0"
                        class="menu-item is-disabled"
                        disabled
                    >
                        <IconHistory :size="14" />
                        <span class="menu-label">No recent files</span>
                    </button>
                    <button
                        v-else
                        class="menu-item subtle-item"
                        role="menuitem"
                        @click="runFileAction('clear-recent')"
                    >
                        <IconX :size="14" />
                        <span class="menu-label">Clear Recent</span>
                    </button>

                    <div class="menu-divider" />
                    <button
                        class="menu-item"
                        role="menuitem"
                        :disabled="!canSave"
                        @click="runFileAction('save')"
                    >
                        <IconDeviceFloppy :size="14" />
                        <span class="menu-label">Save</span>
                        <kbd>{{ shortcut("S") }}</kbd>
                    </button>
                    <button
                        class="menu-item"
                        role="menuitem"
                        :disabled="!canSave"
                        @click="runFileAction('save-as')"
                    >
                        <IconFileDownload :size="14" />
                        <span class="menu-label">Save As</span>
                        <kbd>{{ shortcut("Shift", "S") }}</kbd>
                    </button>
                    <button
                        class="menu-item"
                        role="menuitem"
                        @click="runFileAction('close-file')"
                    >
                        <IconX :size="14" />
                        <span class="menu-label">Close Tab</span>
                        <kbd>{{ shortcut("W") }}</kbd>
                    </button>
                </div>
            </div>

            <div class="menu-group">
                <button
                    class="menu-trigger"
                    :class="{ 'is-open': openMenu === 'edit' }"
                    aria-haspopup="menu"
                    :aria-expanded="openMenu === 'edit'"
                    @click="toggleMenu('edit')"
                >
                    <span>Edit</span>
                    <IconChevronDown :size="11" class="menu-chevron" />
                </button>

                <div
                    v-if="openMenu === 'edit'"
                    class="header-menu edit-menu"
                    role="menu"
                >
                    <button
                        class="menu-item"
                        role="menuitem"
                        @click="runEditAction('undo')"
                    >
                        <IconArrowBackUp :size="14" />
                        <span class="menu-label">Undo</span>
                        <kbd>{{ shortcut("Z") }}</kbd>
                    </button>
                    <button
                        class="menu-item"
                        role="menuitem"
                        @click="runEditAction('redo')"
                    >
                        <IconArrowForwardUp :size="14" />
                        <span class="menu-label">Redo</span>
                        <kbd>{{
                            isMac ? shortcut("Shift", "Z") : shortcut("Y")
                        }}</kbd>
                    </button>

                    <div class="menu-divider" />
                    <button
                        class="menu-item"
                        role="menuitem"
                        @click="runEditAction('cut')"
                    >
                        <IconScissors :size="14" />
                        <span class="menu-label">Cut</span>
                        <kbd>{{ shortcut("X") }}</kbd>
                    </button>
                    <button
                        class="menu-item"
                        role="menuitem"
                        @click="runEditAction('copy')"
                    >
                        <IconCopy :size="14" />
                        <span class="menu-label">Copy</span>
                        <kbd>{{ shortcut("C") }}</kbd>
                    </button>
                    <button
                        class="menu-item"
                        role="menuitem"
                        @click="runEditAction('paste')"
                    >
                        <IconClipboard :size="14" />
                        <span class="menu-label">Paste</span>
                        <kbd>{{ shortcut("V") }}</kbd>
                    </button>
                    <button
                        class="menu-item"
                        role="menuitem"
                        @click="runEditAction('select-all')"
                    >
                        <IconSelectAll :size="14" />
                        <span class="menu-label">Select All</span>
                        <kbd>{{ shortcut("A") }}</kbd>
                    </button>

                    <div class="menu-divider" />
                    <button
                        class="menu-item"
                        role="menuitem"
                        @click="runEditAction('find')"
                    >
                        <IconSearch :size="14" />
                        <span class="menu-label">Find</span>
                        <kbd>{{ shortcut("F") }}</kbd>
                    </button>
                    <button
                        class="menu-item"
                        role="menuitem"
                        :disabled="!hasSelection"
                        @click="runEditAction('rewrite-selection')"
                    >
                        <IconPencil :size="14" />
                        <span class="menu-label">Rewrite Selection</span>
                        <kbd>{{ shortcut("K") }}</kbd>
                    </button>
                </div>
            </div>
        </nav>

        <!-- Right: fixed gap before buttons -->
        <div
            v-if="!embedded"
            data-header-drag-spacer
            data-tauri-drag-region
            class="flex-1 self-stretch"
        ></div>

        <div
            v-if="canOpenInBrowser"
            data-editor-browser-cluster
            class="no-drag flex shrink-0 items-center"
            :class="embedded ? 'mr-1 border-r border-rule pr-1' : ''"
        >
            <button
                type="button"
                data-editor-action="open-in-browser"
                class="sidebar-toggle"
                :class="{ 'has-error': browserOpenError }"
                :title="browserOpenError || 'Open in browser'"
                aria-label="Open in browser"
                :aria-busy="browserOpening"
                :disabled="browserOpening"
                @click="emit('open-in-browser')"
            >
                <IconExternalLink :size="15" :stroke-width="1.8" />
            </button>
            <span v-if="browserOpenError" class="sr-only" role="alert">{{ browserOpenError }}</span>
        </div>

        <!-- Standalone editor sidebar toggle. Workbench pane controls live outside the editor. -->
        <button
            v-if="embedded"
            type="button"
            data-editor-action="expand"
            class="sidebar-toggle no-drag"
            :class="{ 'is-open': editorExpanded }"
            :title="editorExpanded ? 'Restore split' : 'Expand Editor'"
            :aria-label="editorExpanded ? 'Restore split' : 'Expand Editor'"
            @click="workbench.setEditorExpanded(!editorExpanded)"
        >
            <IconArrowsMinimize v-if="editorExpanded" :size="15" :stroke-width="1.8" />
            <IconArrowsMaximize v-else :size="15" :stroke-width="1.8" />
        </button>
        <button
            v-if="embedded"
            type="button"
            data-editor-action="collapse"
            class="sidebar-toggle no-drag"
            title="Collapse editor"
            aria-label="Collapse editor"
            @click="collapseEditor"
        >
            <IconArrowBarToRight :size="15" :stroke-width="1.8" />
        </button>

    </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { platformKind } from "../../../shared/platform.js";
import { basename, dirname } from "../../../shared/utils/path.js";
import { useWorkbenchStore } from "../../../stores/workbench.js";
import TabStrip from "../workspace/TabStrip.vue";
import {
    IconArrowBackUp,
    IconArrowForwardUp,
    IconArrowBarToRight,
    IconArrowBarRight,
    IconArrowsMaximize,
    IconArrowsMinimize,
    IconLayoutSidebarLeftExpand,
    IconChevronDown,
    IconClipboard,
    IconCopy,
    IconDeviceFloppy,
    IconExternalLink,
    IconFileDownload,
    IconFilePlus,
    IconFileText,
    IconFolderOpen,
    IconHistory,
    IconPencil,
    IconScissors,
    IconSearch,
    IconSelectAll,
    IconX,
} from "@tabler/icons-vue";

const props = defineProps({
    embedded: { type: Boolean, default: false },
    showAppMenus: { type: Boolean, default: false },
    recentFiles: { type: Array, default: () => [] },
    canSave: { type: Boolean, default: true },
    hasSelection: { type: Boolean, default: false },
    tabs: { type: Array, default: () => [] },
    activeTab: { type: Number, default: 0 },
    arrivedTabIndex: { type: Number, default: -1 },
    hideSidebar: { type: Boolean, default: false },
    canOpenInBrowser: { type: Boolean, default: false },
    browserOpening: { type: Boolean, default: false },
    browserOpenError: { type: String, default: '' },
});
const emit = defineEmits([
    "new-file",
    "open-file",
    "open-recent",
    "clear-recent",
    "save",
    "save-as",
    "close-file",
    "edit-command",
    "rewrite-selection",
    "select-tab",
    "close-tab",
    "discard-tab",
    "add-tab",
    "reorder-tab",
    "open-in-browser",
]);

const headerRef = ref(null);
const workbench = useWorkbenchStore();
const openMenu = ref(null);
const isMac = computed(() => platformKind() === "macos");
const sidebarRailed = computed(() => workbench.paneLayout.sidebar.state === "rail");
const activityRailed = computed(() => workbench.paneLayout.activity.state === "rail");
const editorExpanded = computed(
    () => workbench.paneLayout.editor.state === "expanded"
        && workbench.paneLayout.activity.state === "rail",
);
const clippedRecentFiles = computed(() => props.recentFiles.slice(0, 7));

function closeMenu() {
    openMenu.value = null;
}

function toggleMenu(menu) {
    openMenu.value = openMenu.value === menu ? null : menu;
}

function shortcut(...keys) {
    if (isMac.value) {
        const hasShift = keys.includes("Shift");
        const rest = keys.filter((key) => key !== "Shift");
        return `${hasShift ? "⇧" : ""}⌘${rest.join("")}`;
    }
    return ["Ctrl", ...keys].join("+");
}

function runFileAction(action) {
    closeMenu();
    const events = {
        "new-file": "new-file",
        "open-file": "open-file",
        "clear-recent": "clear-recent",
        save: "save",
        "save-as": "save-as",
        "close-file": "close-file",
    };
    emit(events[action]);
}

function openRecent(path) {
    closeMenu();
    emit("open-recent", path);
}

function runEditAction(action) {
    closeMenu();
    if (action === "rewrite-selection") {
        emit("rewrite-selection");
        return;
    }
    emit("edit-command", action);
}

async function restorePane(pane) {
    workbench.setPaneState(pane, "expanded");
    await nextTick();
    const target = pane === "sidebar"
        ? document.querySelector("[data-sidebar-collapse], [data-sidebar-workspace]")
        : document.querySelector('[data-pane-header="activity"] button:not(:disabled), [data-pane="activity"] button:not(:disabled)');
    target?.focus();
}

async function collapseEditor() {
    workbench.setPaneState("editor", "rail");
    await nextTick();
    document.querySelector('[data-pane-restore="editor"]')?.focus();
}

function onPointerDown(event) {
    if (!openMenu.value) return;
    if (headerRef.value?.contains(event.target)) return;
    closeMenu();
}

onMounted(() => {
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("blur", closeMenu);
});

onUnmounted(() => {
    document.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("blur", closeMenu);
});
</script>

<style scoped>
.header-action {
    height: 24px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 0 8px;
    flex-shrink: 0;
    color: var(--color-ink-3);
    border: 1px solid var(--color-rule-light);
    border-radius: 5px;
    background: transparent;
    font-family: var(--font-sans);
    font-size: 12px;
    font-weight: 500;
    transition:
        color 140ms ease,
        background 140ms ease,
        border-color 140ms ease;
}

.header-action:hover {
    color: var(--color-ink);
    background: var(--color-chrome-mid);
    border-color: var(--color-rule);
}

.app-menu {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
    height: 26px;
}

.menu-group {
    position: relative;
}

.menu-trigger {
    height: 26px;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 0 8px;
    border: 1px solid transparent;
    border-radius: 5px;
    color: var(--color-ink-2);
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 560;
    line-height: 1;
    transition:
        color 140ms ease,
        background 140ms ease,
        border-color 140ms ease;
}

.menu-trigger:hover,
.menu-trigger.is-open {
    color: var(--color-ink);
    background: var(--color-chrome-mid);
    border-color: var(--color-rule-light);
}

.menu-chevron {
    color: var(--color-ink-3);
    transform: translateY(1px);
}

.header-menu {
    position: absolute;
    top: 29px;
    left: 0;
    min-width: 228px;
    padding: 5px;
    border: 1px solid var(--color-rule);
    border-radius: 7px;
    background: color-mix(
        in srgb,
        var(--color-surface) 96%,
        var(--color-chrome-high)
    );
    box-shadow:
        0 18px 46px rgba(0, 0, 0, 0.18),
        0 2px 8px rgba(0, 0, 0, 0.08);
    z-index: 70;
}

.edit-menu {
    min-width: 214px;
}

.menu-item {
    width: 100%;
    min-height: 28px;
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    padding: 5px 8px;
    border-radius: 5px;
    color: var(--color-ink-2);
    font-family: var(--font-sans);
    font-size: 12px;
    line-height: 1.15;
    text-align: left;
}

.menu-item:hover:not(:disabled),
.menu-item:focus-visible:not(:disabled) {
    color: var(--color-ink);
    background: var(--color-accent-soft);
    outline: none;
}

.menu-item:disabled,
.menu-item.is-disabled {
    color: var(--color-ink-3);
    cursor: default;
}

.menu-item svg {
    color: var(--color-ink-3);
}

.menu-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
}

.menu-item kbd {
    color: var(--color-ink-3);
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 500;
}

.menu-divider {
    height: 1px;
    margin: 5px 4px;
    background: var(--color-rule-light);
}

.menu-section {
    height: 22px;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 0 8px;
    color: var(--color-ink-3);
    font-family: var(--font-sans);
    font-size: 10px;
    font-weight: 620;
    text-transform: uppercase;
}

.recent-item {
    min-height: 34px;
}

.recent-copy {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 2px;
}

.recent-name,
.recent-path {
    overflow: hidden;
    text-overflow: ellipsis;
}

.recent-name {
    color: var(--color-ink);
    font-weight: 560;
}

.recent-path {
    color: var(--color-ink-3);
    font-size: 10px;
}

.subtle-item {
    color: var(--color-ink-3);
}

.sidebar-toggle {
    position: relative;
    width: 28px;
    height: 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--color-ink-3);
    border: 1px solid transparent;
    border-radius: 5px;
    background: transparent;
    transition:
        color 140ms ease,
        background 140ms ease,
        border-color 140ms ease;
}

.sidebar-toggle:hover:not(:disabled) {
    color: var(--color-ink);
    background: var(--color-chrome-mid);
    border-color: var(--color-rule-light);
}

.sidebar-toggle:focus-visible {
    outline: 1px solid var(--color-accent);
    outline-offset: -1px;
}

.sidebar-toggle:disabled {
    cursor: default;
    opacity: 0.45;
}

.sidebar-toggle.has-error {
    color: var(--color-rem);
}

.sidebar-toggle.is-open {
    color: var(--color-ink-2);
}

.sidebar-toggle-icon {
    position: absolute;
    transition:
        opacity 120ms ease,
        transform 150ms ease;
}

.sidebar-toggle-default {
    opacity: 1;
    transform: translateX(0) scale(1);
}

.sidebar-toggle-hover {
    opacity: 0;
    transform: translateX(0) scale(0.92);
}

.sidebar-toggle:hover .sidebar-toggle-default {
    opacity: 0;
    transform: translateX(1px) scale(0.92);
}

.sidebar-toggle:hover .sidebar-toggle-hover {
    opacity: 1;
    transform: translateX(0) scale(1);
}

</style>
