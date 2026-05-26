<template>
    <header
        class="drag-region relative h-[40px] grid grid-cols-[auto_minmax(0,1fr)] items-center shrink-0"
        :class="
            sidebarOpen
                ? 'bg-transparent'
                : 'bg-chrome-high border-b border-rule-light'
        "
        data-tauri-drag-region="deep"
    >
        <div
            class="flex items-center gap-1 px-2 min-w-max z-[1] pb-1"
            :class="sidebarOpen && 'max-sm:!min-w-max'"
            :style="sidebarOpen ? { minWidth: sidebarWidth + 'px' } : undefined"
            data-tauri-drag-region="deep"
        >
            <div
                class="w-[68px] self-stretch shrink-0"
                data-tauri-drag-region
                aria-hidden="true"
            />
            <button
                class="sidebar-toggle no-drag"
                :class="sidebarOpen ? 'is-open' : 'is-closed'"
                title="Toggle sidebar"
                @click="$emit('toggle-sidebar')"
            >
                <component
                    :is="defaultIcon"
                    :size="18"
                    class="sidebar-toggle-icon sidebar-toggle-default"
                />
                <component
                    :is="hoverIcon"
                    :size="18"
                    class="sidebar-toggle-icon sidebar-toggle-hover"
                />
            </button>
            <button
                v-if="!sidebarOpen"
                class="no-drag w-[26px] h-[26px] rounded-[5px] inline-flex items-center justify-center shrink-0 text-ink-3 bg-transparent hover:text-ink hover:bg-chrome-mid"
                title="New chat"
                @click="startChat"
            >
                <IconPlus :size="15" />
            </button>
            <button
                class="no-drag w-[26px] h-[26px] rounded-[5px] inline-flex items-center justify-center shrink-0 text-ink-3 bg-transparent hover:text-ink hover:bg-chrome-mid disabled:opacity-30 disabled:pointer-events-none"
                :disabled="!panelUI.canGoBack"
                title="Back"
                @click="navigateBack"
            >
                <IconChevronLeft :size="14" />
            </button>
            <button
                class="no-drag w-[26px] h-[26px] rounded-[5px] inline-flex items-center justify-center shrink-0 text-ink-3 bg-transparent hover:text-ink hover:bg-chrome-mid disabled:opacity-30 disabled:pointer-events-none"
                :disabled="!panelUI.canGoForward"
                title="Forward"
                @click="navigateForward"
            >
                <IconChevronRight :size="14" />
            </button>
        </div>
        <div
            class="flex items-center gap-1 px-8 min-w-0 h-full border-b-0 border-rule-light"
            :class="
                sidebarOpen &&
                'bg-chrome-high rounded-tl-xl border-l border-rule-light border-b-1'
            "
            data-tauri-drag-region="deep"
        >
            <template v-if="panelUI.projectHomeId">
                <span class="font-sans text-[12px] font-medium text-ink truncate">
                    {{ projectName }}
                </span>
                <span v-if="projectPath" class="font-mono text-[10px] text-ink-3 truncate ml-1.5" style="direction: rtl; text-align: left;">
                    {{ projectPath }}
                </span>
                <button
                    v-if="projectPath"
                    class="no-drag w-[22px] h-[22px] rounded-[4px] inline-flex items-center justify-center shrink-0 text-ink-3 hover:text-ink-2 hover:bg-chrome-mid"
                    title="Open project folder"
                    @click="revealProjectFolder"
                >
                    <IconFolderOpen :size="13" />
                </button>
            </template>
            <template v-else-if="session">
                <input
                    v-if="renaming"
                    ref="renameInputRef"
                    v-model="renameValue"
                    class="no-drag ph-rename-input"
                    autocorrect="off"
                    autocapitalize="off"
                    @keydown.enter="commitRename"
                    @keydown.escape="cancelRename"
                    @blur="commitRename"
                />
                <span
                    v-else
                    class="text-[13px] font-semibold text-ink truncate cursor-default"
                    @dblclick="startRename"
                >
                    {{ session.label }}
                </span>
                <div ref="menuAnchorRef" class="relative shrink-0">
                    <button
                        class="no-drag w-[22px] h-[22px] rounded-[4px] inline-flex items-center justify-center text-ink-3 hover:text-ink-2 hover:bg-chrome-mid"
                        title="Session options"
                        @click="menuOpen = !menuOpen"
                    >
                        <IconDotsVertical :size="14" />
                    </button>
                    <div v-if="menuOpen" class="ph-menu">
                        <button class="ph-menu-item" @click="startRename">
                            <IconPencil :size="13" />
                            <span>Rename</span>
                        </button>
                        <button class="ph-menu-item" @click="onPin">
                            <component
                                :is="session.pinned ? IconPinnedOff : IconPin"
                                :size="13"
                            />
                            <span>{{ session.pinned ? "Unpin" : "Pin" }}</span>
                        </button>
                        <button class="ph-menu-item" @click="onExport">
                            <IconDownload :size="13" />
                            <span>Export</span>
                        </button>
                        <div class="ph-menu-divider" />
                        <button class="ph-menu-item" @click="onArchive">
                            <IconArchive :size="13" />
                            <span>Archive</span>
                        </button>
                    </div>
                </div>
            </template>

            <div
                data-tauri-drag-region
                class="min-w-[40px] flex-1 self-stretch"
            />

            <button
                class="no-drag ph-terminal-btn"
                :class="{ 'is-active': panelUI.terminalOpen }"
                title="Toggle terminal"
                @click="panelUI.toggleTerminal()"
            >
                <IconTerminal2 :size="14" />
            </button>
            <button
                class="no-drag ph-editor-btn"
                title="Open Editor"
                @click="openEditor"
            >
                <IconExternalLink :size="14" />
                <span>Editor</span>
            </button>
        </div>
    </header>
</template>

<script setup>
import { computed, ref, nextTick, onMounted, onUnmounted } from "vue";
import {
    IconLayoutSidebar,
    IconLayoutSidebarLeftCollapse,
    IconLayoutSidebarFilled,
    IconLayoutSidebarLeftExpand,
    IconChevronLeft,
    IconChevronRight,
    IconPlus,
    IconDotsVertical,
    IconPencil,
    IconPin,
    IconPinnedOff,
    IconDownload,
    IconArchive,
    IconExternalLink,
    IconTerminal2,
    IconFolderOpen,
} from "@tabler/icons-vue";
import { usePanelUIStore } from "../../stores/panel/ui.js";
import { useSessionStore } from "../../stores/panel/sessions.js";
import { useProjectStore } from "../../stores/panel/projects.js";
import * as actions from "../../stores/panel/actions.js";
import { openOrFocusEditorWindow } from "../agentsWindow.js";

const props = defineProps({
    sidebarOpen: { type: Boolean, default: true },
    sidebarWidth: { type: Number, default: 256 },
});
defineEmits(["toggle-sidebar"]);

const panelUI = usePanelUIStore();
const sessionStore = useSessionStore();
const projStore = useProjectStore();

const session = computed(() => sessionStore.activeSession);

const projectName = computed(() => {
    if (!panelUI.projectHomeId) return '';
    const proj = projStore.projects.find(p => p.id === panelUI.projectHomeId);
    return proj?.name || '';
});

const projectPath = computed(() => {
    if (!panelUI.projectHomeId) return '';
    const proj = projStore.projects.find(p => p.id === panelUI.projectHomeId);
    return proj?.workspacePath || '';
});

const defaultIcon = computed(() =>
    props.sidebarOpen ? IconLayoutSidebarFilled : IconLayoutSidebar,
);
const hoverIcon = computed(() =>
    props.sidebarOpen
        ? IconLayoutSidebarLeftCollapse
        : IconLayoutSidebarLeftExpand,
);

const menuOpen = ref(false);
const menuAnchorRef = ref(null);
const renaming = ref(false);
const renameValue = ref("");
const renameInputRef = ref(null);

async function startRename() {
    menuOpen.value = false;
    if (!session.value) return;
    renameValue.value = session.value.label;
    renaming.value = true;
    await nextTick();
    renameInputRef.value?.select();
}

function commitRename() {
    if (!renaming.value) return;
    renaming.value = false;
    if (!session.value) return;
    const trimmed = renameValue.value.trim();
    if (trimmed && trimmed !== session.value.label) {
        sessionStore.renameSession(session.value.id, trimmed);
    }
}

function cancelRename() {
    renaming.value = false;
}

function onPin() {
    menuOpen.value = false;
    if (session.value) sessionStore.togglePinSession(session.value.id);
}

function onExport() {
    menuOpen.value = false;
    if (session.value) sessionStore.exportSession(session.value.id);
}

function onArchive() {
    menuOpen.value = false;
    actions.archiveActiveSession();
}

function onPointerDown(event) {
    if (menuAnchorRef.value && !menuAnchorRef.value.contains(event.target)) {
        menuOpen.value = false;
    }
}

function onKeydown(event) {
    if (event.key === "Escape" && menuOpen.value) {
        menuOpen.value = false;
    }
}

onMounted(() => {
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeydown);
});

onUnmounted(() => {
    document.removeEventListener("pointerdown", onPointerDown);
    document.removeEventListener("keydown", onKeydown);
});

function navigateBack() {
    actions.navigateHistory('back');
}

function navigateForward() {
    actions.navigateHistory('forward');
}

async function openEditor() {
    await openOrFocusEditorWindow();
}

async function revealProjectFolder() {
    if (!projectPath.value) return
    const { open } = await import('@tauri-apps/plugin-shell')
    open(projectPath.value)
}

async function startChat() {
    const active = sessionStore.activeSession;
    if (
        !panelUI.projectHomeId &&
        active &&
        !active._userMessageSent &&
        sessionStore.sessionMessageCount(active) === 0
    ) {
        return;
    }
    const projectId =
        panelUI.projectHomeId || active?.projectId || "general";
    panelUI.newChatStartMode = "chat";
    await actions.createSessionWithChat(null, { projectId });
}
</script>

<style scoped>
.ph-menu {
    position: absolute;
    z-index: 50;
    top: 28px;
    right: 0;
    min-width: 160px;
    padding: 4px;
    background: var(--color-surface);
    border: 1px solid var(--color-rule);
    border-radius: 6px;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.18);
}

.ph-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 28px;
    padding: 0 8px;
    border-radius: 4px;
    color: var(--color-ink-2);
    font-family: var(--font-sans);
    font-size: 12px;
    text-align: left;
    -webkit-app-region: no-drag;
}
.ph-menu-item:hover {
    background: var(--color-accent-soft);
    color: var(--color-ink);
}

.ph-menu-divider {
    height: 1px;
    margin: 4px;
    background: var(--color-rule-light);
}

.ph-rename-input {
    font-size: 13px;
    font-weight: 600;
    color: var(--color-ink);
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--color-accent);
    outline: none;
    padding: 0;
    min-width: 0;
    width: 100%;
    font-family: inherit;
}

.ph-terminal-btn {
    width: 26px;
    height: 24px;
    border-radius: 5px;
    border: 1px solid var(--color-rule-light);
    background: transparent;
    color: var(--color-ink-3);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
}
.ph-terminal-btn:hover {
    color: var(--color-ink);
    background: var(--color-chrome-mid);
}
.ph-terminal-btn.is-active {
    background: var(--color-accent-soft);
    color: var(--color-accent);
    border-color: transparent;
}

.ph-editor-btn {
    height: 24px;
    padding: 0 8px;
    border-radius: 5px;
    border: 1px solid var(--color-rule-light);
    background: transparent;
    color: var(--color-ink-3);
    font-family: var(--font-sans);
    font-size: 12px;
    font-weight: 500;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex-shrink: 0;
}
.ph-editor-btn:hover {
    color: var(--color-ink);
    background: var(--color-chrome-mid);
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
    color: var(--color-ink-3);
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
    transform: translateX(-1px) scale(0.92);
}

.sidebar-toggle:hover .sidebar-toggle-hover {
    opacity: 1;
    transform: translateX(0) scale(1);
}
</style>
