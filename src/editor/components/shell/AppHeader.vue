<template>
    <div
        ref="headerRef"
        data-tauri-drag-region="deep"
        class="relative z-40 h-10 shrink-0 flex items-center gap-0 px-[14px] bg-chrome whitespace-nowrap overflow-visible drag-region"
        @keydown.esc="closeMenu"
    >
        <!-- Left: traffic-light spacer -->
        <div
            data-tauri-drag-region="deep"
            class="relative w-[56px] shrink-0 self-stretch"
            aria-hidden="true"
        ></div>

        <!-- Gap between traffic lights and tabs -->
        <div data-tauri-drag-region class="w-7 shrink-0 self-stretch"></div>

        <!-- File tabs -->
        <TabStrip
            :tabs="tabs"
            :activeTab="activeTab"
            :arrivedTabIndex="arrivedTabIndex"
            @select-tab="$emit('select-tab', $event)"
            @close-tab="$emit('close-tab', $event)"
            @add-tab="$emit('add-tab')"
            @reorder-tab="(from, to) => $emit('reorder-tab', from, to)"
            @tab-drag-out="(idx, x, y) => $emit('tab-drag-out', idx, x, y)"
        />

        <!-- App menus (Windows/Linux only) -->
        <nav
            v-if="showAppMenus"
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
            data-tauri-drag-region
            class="w-7 shrink-0 self-stretch"
        ></div>

        <!-- MimPanel mode: collapse + panel toggles -->
        <template v-if="hideSidebar && mimToggles">
            <button
                class="mim-collapse-btn no-drag"
                title="Collapse panel"
                @click="mimToggles.collapse()"
            >
                <IconLayoutSidebarRightCollapse :size="14" />
            </button>
            <div class="mim-panel-toggles no-drag">
                <button
                    v-for="p in mimToggles.panels"
                    :key="p.id"
                    class="mim-ptoggle"
                    :class="{ active: mimToggles.rightPanel.value === p.id }"
                    @click="mimToggles.setRightPanel(p.id)"
                >{{ p.label }}</button>
            </div>
        </template>

        <!-- Standalone mode: export + sidebar toggle -->
        <div v-else-if="!hideSidebar" class="flex items-center gap-[6px] shrink-0">
            <button
                ref="exportBtnRef"
                class="header-action no-drag"
                title="Export"
                @click="exportPopover.toggle()"
            >
                <IconFileExport :size="14" />
                <span>Export</span>
            </button>

            <button
                class="sidebar-toggle group no-drag"
                :class="sidebarOpen ? 'is-open' : 'is-closed'"
                :title="
                    sidebarOpen
                        ? `Collapse sidebar ${shortcut('\\')}`
                        : `Expand sidebar ${shortcut('\\')}`
                "
                :aria-label="
                    sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'
                "
                @click="toggleSidebar"
            >
                <component
                    :is="defaultSidebarIcon"
                    :size="18"
                    class="sidebar-toggle-icon sidebar-toggle-default"
                />
                <component
                    :is="hoverSidebarIcon"
                    :size="18"
                    class="sidebar-toggle-icon sidebar-toggle-hover"
                />
            </button>
        </div>
    </div>

    <!-- Export popover (rendered outside header to avoid overflow clipping) -->
    <div
        v-if="exportPopover.isOpen.value"
        ref="exportFloatingRef"
        :style="exportPopover.floatingStyles.value"
        class="export-popover"
    >
        <SidebarExport :references="references" />
    </div>
</template>

<script setup>
import { computed, inject, onMounted, onUnmounted, ref, watch } from "vue";
import { platformKind } from "../../../shared/platform.js";
import { basename, dirname } from "../../../shared/utils/path.js";
import { usePopover } from "../../../shared/composables/usePopover.js";
import SidebarExport from "../sidebar/SidebarExport.vue";
import TabStrip from "../workspace/TabStrip.vue";
import {
    IconArrowBackUp,
    IconArrowForwardUp,
    IconLayoutSidebarRightCollapse,
    IconLayoutSidebarRightExpand,
    IconLayoutSidebarRight,
    IconLayoutSidebarRightFilled,
    IconChevronDown,
    IconClipboard,
    IconCopy,
    IconDeviceFloppy,
    IconFileDownload,
    IconFileExport,
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
    sidebarOpen: { type: Boolean, default: false },
    showAppMenus: { type: Boolean, default: false },
    recentFiles: { type: Array, default: () => [] },
    canSave: { type: Boolean, default: true },
    hasSelection: { type: Boolean, default: false },
    references: { type: Array, default: () => [] },
    tabs: { type: Array, default: () => [] },
    activeTab: { type: Number, default: 0 },
    arrivedTabIndex: { type: Number, default: -1 },
    hideSidebar: { type: Boolean, default: false },
});
const emit = defineEmits([
    "toggle-sidebar",
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
    "add-tab",
    "reorder-tab",
    "tab-drag-out",
]);

const headerRef = ref(null);
const openMenu = ref(null);
const isMac = computed(() => platformKind() === "macos");
const clippedRecentFiles = computed(() => props.recentFiles.slice(0, 7));

const mimToggles = inject("mimPanelToggles", null);

// Export popover
const exportBtnRef = ref(null);
const exportFloatingRef = ref(null);
const exportPopover = usePopover({ placement: "bottom-end", offsetPx: 4 });

watch(exportBtnRef, (el) => {
    exportPopover.referenceRef.value = el;
});
watch(exportFloatingRef, (el) => {
    exportPopover.floatingRef.value = el;
});

// Sidebar toggle icons (right-side sidebar)
const defaultSidebarIcon = computed(() =>
    props.sidebarOpen ? IconLayoutSidebarRightFilled : IconLayoutSidebarRight,
);
const hoverSidebarIcon = computed(() =>
    props.sidebarOpen
        ? IconLayoutSidebarRightCollapse
        : IconLayoutSidebarRightExpand,
);

function toggleSidebar() {
    emit("toggle-sidebar");
}
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

.sidebar-toggle:hover {
    color: var(--color-ink);
    background: var(--color-chrome-mid);
    border-color: var(--color-rule-light);
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

/* ── MimPanel toggles ── */

.mim-collapse-btn {
    width: 28px;
    height: 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    margin-right: 6px;
    border: 1px solid transparent;
    border-radius: 5px;
    background: transparent;
    color: var(--color-ink-3);
    transition: color 140ms, background 140ms, border-color 140ms;
}

.mim-collapse-btn:hover {
    color: var(--color-ink);
    background: var(--color-chrome-mid);
    border-color: var(--color-rule-light);
}

.mim-panel-toggles {
    display: flex;
    gap: 1px;
    background: var(--color-chrome-mid);
    border-radius: 5px;
    padding: 2px;
    flex-shrink: 0;
}

.mim-ptoggle {
    height: 22px;
    padding: 0 8px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--color-ink-3);
    font-family: var(--font-sans);
    font-size: 10.5px;
    font-weight: 560;
    white-space: nowrap;
    transition: color 100ms, background 100ms;
}

.mim-ptoggle:hover {
    color: var(--color-ink-2);
}

.mim-ptoggle.active {
    background: var(--color-surface);
    color: var(--color-ink);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.export-popover {
    width: 280px;
    max-height: 80vh;
    overflow-y: auto;
    background: var(--color-surface);
    border: 1px solid var(--color-rule);
    border-radius: 7px;
    box-shadow:
        0 18px 46px rgba(0, 0, 0, 0.18),
        0 2px 8px rgba(0, 0, 0, 0.08);
    z-index: 70;
}
</style>
