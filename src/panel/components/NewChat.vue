<template>
    <main class="nc-main">
        <div class="nc-scroll">
            <div class="nc-grid">
                <div class="nc-center">
                    <h1 class="nc-heading">What should we work on?</h1>

                    <div class="nc-composer-wrap" ref="composerWrapRef">
                        <Composer
                            ref="composerRef"
                            :model-id="session?.modelId"
                            :models="sessionStore.selectableModels"
                            :control-id="control.id"
                            :control-label="control.label"
                            :control-options="control.options"
                            :disabled="!props.embedded && !session"
                            :busy="false"
                            :can-send="canSend"
                            :cost-label="'$0.00'"
                            :skills="skills"
                            :project-files="projectFiles"
                            :has-document="hasDocument"
                            :document-name="documentName"
                            :board-entries="boardEntries"
                            @send="send"
                            @attach="onAttach"
                            @pick-skill="onPickSkill"
                            @pick-project-file="onPickProjectFile"
                            @pick-document="onPickDocument"
                            @pick-board-entry="onPickBoardEntry"
                            @update:model-id="
                                (id) =>
                                    session &&
                                    sessionStore.setSessionModel(session, id)
                            "
                            @update:control-id="
                                (id) =>
                                    session &&
                                    sessionStore.setSessionControl(session, id)
                            "
                        />
                    </div>

                    <div class="nc-below-row">
                        <div class="nc-below-left">
                            <div
                                ref="projectPickerRef"
                                class="nc-project-picker"
                            >
                                <button
                                    v-if="!props.embedded && canChangeProject"
                                    class="nc-project-trigger"
                                    @click="
                                        projectPickerOpen = !projectPickerOpen
                                    "
                                >
                                    <IconUser
                                        v-if="selectedProject?.system"
                                        :size="12"
                                    />
                                    <IconFolder v-else :size="12" />
                                    <span>{{
                                        selectedProject?.name || "Personal"
                                    }}</span>
                                    <IconChevronDown
                                        :size="10"
                                        style="color: var(--color-ink-3)"
                                    />
                                </button>
                                <div v-else class="nc-project-static">
                                    <IconUser
                                        v-if="selectedProject?.system"
                                        :size="12"
                                    />
                                    <IconFolder v-else :size="12" />
                                    <span>{{
                                        selectedProject?.name || "Personal"
                                    }}</span>
                                </div>
                                <div
                                    v-if="projectPickerOpen"
                                    class="nc-project-dropdown"
                                >
                                    <button
                                        v-for="project in projStore.projects"
                                        :key="project.id"
                                        class="nc-project-option"
                                        :class="{
                                            selected:
                                                project.id ===
                                                selectedProjectId,
                                        }"
                                        @click="selectProject(project.id)"
                                    >
                                        <IconUser
                                            v-if="project.system"
                                            :size="12"
                                        />
                                        <IconFolder v-else :size="12" />
                                        <span>{{ project.name }}</span>
                                        <span
                                            v-if="project.workspacePath"
                                            class="nc-project-path"
                                            >{{
                                                shortenPath(
                                                    project.workspacePath,
                                                )
                                            }}</span
                                        >
                                    </button>
                                </div>
                            </div>
                            <div
                                ref="approvalPickerRef"
                                class="approval-picker"
                            >
                                <button
                                    class="approval-trigger"
                                    :class="{
                                        'approval-trigger--danger':
                                            effectiveApprovalMode === 'bypass',
                                    }"
                                    @click="
                                        approvalMenuOpen = !approvalMenuOpen
                                    "
                                >
                                    <IconShield :size="11" />
                                    <span>{{ effectiveApprovalMode }}</span>
                                    <IconChevronDown :size="9" />
                                </button>
                                <div
                                    v-if="approvalMenuOpen"
                                    class="approval-menu"
                                >
                                    <button
                                        v-for="mode in approvalModes"
                                        :key="mode.id"
                                        class="approval-option"
                                        :class="{
                                            selected:
                                                mode.id ===
                                                effectiveApprovalMode,
                                            'approval-danger':
                                                mode.id === 'bypass',
                                        }"
                                        @click="setApprovalMode(mode.id)"
                                    >
                                        <span class="approval-option-name">{{
                                            mode.label
                                        }}</span>
                                        <span class="approval-option-desc">{{
                                            mode.desc
                                        }}</span>
                                    </button>
                                </div>
                            </div>
                        </div>
                        <div class="nc-below-right">
                        </div>
                    </div>

                    <div
                        v-if="appStore.apps.length > 0"
                        class="nc-apps-section"
                    >
                        <div class="nc-apps-label">Apps</div>
                        <div class="nc-apps-grid">
                            <button
                                v-for="app in visibleApps"
                                :key="app.id"
                                class="nc-app-card"
                                @click="onLaunchApp(app)"
                            >
                                <span v-if="app.icon" class="nc-app-icon">{{
                                    app.icon
                                }}</span>
                                <span
                                    v-else
                                    class="nc-app-icon nc-app-icon-default"
                                    >&#9670;</span
                                >
                                <div class="nc-app-meta">
                                    <div class="nc-app-name">
                                        {{ app.name }}
                                    </div>
                                    <div
                                        v-if="app.description"
                                        class="nc-app-desc"
                                    >
                                        {{ app.description }}
                                    </div>
                                </div>
                            </button>
                        </div>
                        <div
                            v-if="appStore.apps.length > 3"
                            class="nc-apps-more-wrap"
                            ref="appsOverlayRef"
                        >
                            <button
                                class="nc-apps-more"
                                @click="appsExpanded = !appsExpanded"
                            >
                                {{
                                    appsExpanded
                                        ? "Show less"
                                        : `Show all (${appStore.apps.length})`
                                }}
                            </button>
                            <div v-if="appsExpanded" class="nc-apps-overlay">
                                <button
                                    v-for="app in appStore.recentApps"
                                    :key="'all-' + app.id"
                                    class="nc-drop-item"
                                    @click="
                                        onLaunchApp(app);
                                        appsExpanded = false;
                                    "
                                >
                                    <span class="nc-drop-icon">{{
                                        app.icon || "&#9670;"
                                    }}</span>
                                    <div class="nc-drop-meta">
                                        <div class="nc-drop-name">
                                            {{ app.name }}
                                        </div>
                                        <div class="nc-drop-desc">
                                            {{ app.description || "" }}
                                        </div>
                                    </div>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </main>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { usePanelUIStore } from "../../stores/panel/ui.js";
import { useProjectStore } from "../../stores/panel/projects.js";
import { useSessionStore } from "../../stores/panel/sessions.js";
import { useChatStore } from "../../stores/panel/chat.js";
import { useSkillsStore } from "../../stores/panel/skills.js";
import { useAppStore } from "../../stores/panel/apps.js";
import { useBoardStore } from "../../stores/panel/board.js";
import { chatMessages } from "../../stores/panel/helpers.js";
import { pickAndReadAttachment } from "../../services/attachmentPicker.js";
import * as actions from "../../stores/panel/actions.js";
import Composer from "./Composer.vue";
import { useSettingsStore } from "../../stores/settings.js";
import {
    IconUser,
    IconFolder,
    IconChevronDown,
    IconShield,
} from "@tabler/icons-vue";

const props = defineProps({
    embedded: { type: Boolean, default: false },
    projectId: { type: String, default: "" },
});

const panelUI = usePanelUIStore();
const projStore = useProjectStore();
const sessionStore = useSessionStore();
const chat = useChatStore();
const skillsStore = useSkillsStore();
const appStore = useAppStore();
const boardStore = useBoardStore();
const settingsStore = useSettingsStore();

const approvalMenuOpen = ref(false);
const approvalPickerRef = ref(null);
const composerRef = ref(null);
const composerWrapRef = ref(null);
const selectedProjectId = ref("");
const projectPickerOpen = ref(false);
const projectPickerRef = ref(null);
const appsExpanded = ref(false);
const appsOverlayRef = ref(null);

const skills = computed(() =>
    skillsStore.enabledSkills.map((s) => ({
        id: s.id,
        name: s.name,
        desc: s.description,
    })),
);

const projectFiles = computed(() =>
    projStore.projectFileIndex.map((f) => ({
        path: f,
        name: f.split("/").pop(),
    })),
);

const boardEntries = computed(() =>
    boardStore.entries.map((e) => ({
        id: e.id,
        title: e.meta.title,
        type: e.meta.type,
        status: e.meta.status,
        tags: e.meta.tags || [],
    })),
);

const hasDocument = computed(() => {
    try { return Boolean(localStorage.getItem("mim:doc")); }
    catch { return false; }
});

const documentName = computed(() => {
    try {
        const path = localStorage.getItem("mim:doc:path") || "";
        return path.split("/").pop() || "Untitled";
    } catch { return "Untitled"; }
});

const visibleApps = computed(() => appStore.recentApps.slice(0, 3));

const session = computed(() => sessionStore.activeSession);
const control = computed(() => {
    if (!session.value) return { id: "", label: "", options: [] };
    return sessionStore.currentControl(session.value);
});

const canSend = computed(() => {
    const text = (composerRef.value?.draft || "").trim();
    const hasAttachments = (composerRef.value?.attachments?.length || 0) > 0;
    const hasChips = (composerRef.value?.contextChips?.length || 0) > 0;
    const hasContent = text.length > 0 || hasAttachments || hasChips;
    if (props.embedded) return hasContent;
    return Boolean(session.value && chat.canSend && hasContent);
});

const selectedProject = computed(
    () =>
        projStore.projects.find((p) => p.id === selectedProjectId.value) ||
        projStore.projects[0],
);

const canChangeProject = computed(() => {
    const current = session.value;
    if (!current) return true;
    return !current.projectLocked && chatMessages(current).length === 0;
});

function selectProject(id) {
    if (!canChangeProject.value) return;
    selectedProjectId.value = id;
    projectPickerOpen.value = false;
    actions.setActiveDraftProject(id);
}

function shortenPath(path) {
    if (!path) return "";
    const parts = path.split("/");
    return parts.length > 3 ? `.../${parts.slice(-2).join("/")}` : path;
}

const approvalModes = [
    { id: "strict", label: "Strict", desc: "Approve every tool use" },
    { id: "normal", label: "Normal", desc: "Approve sensitive actions" },
    { id: "bypass", label: "Bypass Approval", desc: "No approval prompts" },
];

const effectiveApprovalMode = computed(() => {
    const project = projStore.projects.find(
        (p) => p.id === selectedProjectId.value,
    );
    const projectMode = project?.approvalMode;
    if (projectMode && projectMode !== "default") return projectMode;
    return settingsStore.aiApprovalMode || "normal";
});

function setApprovalMode(mode) {
    const project = projStore.projects.find(
        (p) => p.id === selectedProjectId.value,
    );
    if (project) {
        project.approvalMode = mode;
    } else {
        settingsStore.aiApprovalMode = mode;
    }
    approvalMenuOpen.value = false;
}

async function send({ text, attachments }) {
    if (!text && (!attachments || attachments.length === 0)) return;

    const chips = composerRef.value?.contextChips || [];
    const skillChip = chips.find((c) => c.type === "skill");

    // Resolve document context chip into attachment
    const docChip = chips.find((c) => c.type === "document");
    if (docChip) {
        try {
            const content = localStorage.getItem("mim:doc") || "";
            if (content) {
                const name = documentName.value || "document.md";
                attachments = [...(attachments || []), { filename: name, mediaType: "text/markdown", content, type: "text", size: content.length }];
            }
        } catch { /* no document content */ }
    }

    const entryIds = (attachments || []).filter(a => a._entryId).map(a => a._entryId);

    if (props.embedded && props.projectId) {
        const newSession = await actions.startProjectChat(props.projectId);
        if (!newSession) return;
        if (skillChip) {
            newSession.skill = skillChip.id;
        }
        if (entryIds.length) {
            if (!newSession.linkedEntries) newSession.linkedEntries = [];
            for (const id of entryIds) {
                if (!newSession.linkedEntries.includes(id)) {
                    newSession.linkedEntries.push(id);
                }
            }
        }
        chat.sendMessage(text, attachments || []);
        composerRef.value?.clearContextChips();
        panelUI.newChatStartMode = "chat";
        return;
    }

    if (!chat.canSend) return;

    const currentSession = sessionStore.activeSession;
    const targetProjectId = currentSession?.projectLocked
        ? currentSession.projectId
        : selectedProjectId.value || projStore.projects[0]?.id || "general";
    actions.lockActiveSessionToProject(targetProjectId);
    selectedProjectId.value = targetProjectId;

    const activeSession = sessionStore.activeSession;
    if (skillChip && activeSession) {
        activeSession.skill = skillChip.id;
    }
    if (entryIds.length && activeSession) {
        if (!activeSession.linkedEntries) activeSession.linkedEntries = [];
        for (const id of entryIds) {
            if (!activeSession.linkedEntries.includes(id)) {
                activeSession.linkedEntries.push(id);
            }
        }
    }
    chat.sendMessage(text, attachments || []);
    composerRef.value?.clearContextChips();
    panelUI.newChatStartMode = "chat";
}

async function onAttach(type) {
    const result = await pickAndReadAttachment(type);
    if (!result || result.error) return;
    composerRef.value?.addAttachment(result);
}

function onPickSkill(_skill) {
    // Skill chip is managed inside Composer.contextChips.
    // We apply it to the session on send.
}

async function onPickProjectFile(file) {
    if (composerRef.value?.attachments?.some(a => a.filename === file.name && a.type === 'text')) return;
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        const resp = await invoke("read_text_file", { path: file.path });
        const mediaType = "text/plain";
        composerRef.value?.addAttachment({
            filename: file.name,
            mediaType,
            content: resp.content,
            type: "text",
            size: new Blob([resp.content]).size,
        });
    } catch (e) {
        console.warn("Failed to read project file:", e);
    }
}

function onPickDocument() {
    // Content is resolved at send time — the context chip is the only visual indicator
}

async function onPickBoardEntry(entry) {
    const boardEntry = boardStore.entries.find((e) => e.id === entry.id);
    if (!boardEntry) return;
    if (composerRef.value?.attachments?.some(a => a._entryId === entry.id)) return;
    const prefix = boardEntry.meta.type === 'issue' ? '@issues' : '@knowledge';
    const atPath = `${prefix}/${entry.id}.md`;
    const content = `Path: ${atPath}\n# ${boardEntry.meta.title}\n\n${boardEntry.body || ""}`;
    composerRef.value?.addAttachment({
        filename: `${entry.id}.md`,
        mediaType: "text/markdown",
        content,
        type: "text",
        size: content.length,
        _entryId: entry.id,
    });
}

function onLaunchApp(app) {
    const projectId =
        selectedProjectId.value || projStore.projects[0]?.id || "general";
    actions.launchApp(app.id, projectId);
}

function onClickOutside(event) {
    if (
        projectPickerRef.value &&
        !projectPickerRef.value.contains(event.target)
    ) {
        projectPickerOpen.value = false;
    }
    if (
        approvalPickerRef.value &&
        !approvalPickerRef.value.contains(event.target)
    ) {
        approvalMenuOpen.value = false;
    }
    if (appsOverlayRef.value && !appsOverlayRef.value.contains(event.target)) {
        appsExpanded.value = false;
    }
}

onMounted(() => {
    document.addEventListener("pointerdown", onClickOutside, true);
    composerRef.value?.focus?.();
    if (props.embedded && props.projectId) {
        selectedProjectId.value = props.projectId;
    } else {
        selectedProjectId.value =
            sessionStore.activeProject?.id ||
            projStore.projects[0]?.id ||
            "general";
        appStore.discover();
    }
    skillsStore.refreshSkills();
    if (selectedProjectId.value) boardStore.loadBoard(selectedProjectId.value);
});
onUnmounted(() =>
    document.removeEventListener("pointerdown", onClickOutside, true),
);

watch(
    () => sessionStore.activeSession?.id,
    async () => {
        selectedProjectId.value =
            sessionStore.activeProject?.id ||
            projStore.projects[0]?.id ||
            "general";
        projectPickerOpen.value = false;
        await nextTick();
        await populateLinkedEntryChips();
    },
    { immediate: true },
);

async function populateLinkedEntryChips() {
    const s = sessionStore.activeSession;
    if (!s?.linkedEntries?.length) return;
    const composer = composerRef.value;
    if (!composer) return;
    if (s.projectId && !boardStore.entries.length) {
        await boardStore.loadBoard(s.projectId);
    }
    for (const entryId of s.linkedEntries) {
        const entry = boardStore.entries.find(e => e.id === entryId);
        if (!entry) continue;
        if (composer.attachments?.some(a => a._entryId === entryId)) continue;
        composer.addContextChip({ type: 'board-entry', id: entryId, label: entry.meta.title, entryType: entry.meta.type });
        onPickBoardEntry({ id: entryId });
    }
}
</script>

<style scoped>
.nc-main {
    position: relative;
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    background: var(--color-chrome-high);
    overflow: hidden;
}
.nc-scroll {
    flex: 1;
    overflow: hidden;
    padding: 0 40px;
}

.nc-grid {
    min-height: 100%;
    max-width: 640px;
    width: 100%;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    padding-top: clamp(120px, 24vh, 240px);
}

.nc-center {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
}

.nc-heading {
    font-family: var(--font-brand);
    font-size: 21px;
    font-weight: 400;
    color: var(--color-ink);
    margin-bottom: 18px;
    letter-spacing: 0;
    text-align: center;
}

/* Composer wrapper */
.nc-composer-wrap {
    position: relative;
    width: 100%;
}
.nc-composer-wrap :deep(.composer-wrap) {
    padding: 0;
    max-width: none;
}

/* Below-composer row */
.nc-below-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 8px 4px 0;
}
.nc-below-left {
    display: flex;
    align-items: center;
}
.nc-below-right {
    position: relative;
    display: flex;
    align-items: center;
    gap: 2px;
}

/* Project picker */
.nc-project-picker {
    position: relative;
}
.nc-project-trigger {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    border-radius: 4px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--color-ink-2);
}
.nc-project-trigger:hover {
    background: var(--color-chrome-high);
}
.nc-project-static {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    border-radius: 4px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--color-ink-2);
    background: var(--color-surface);
}
.nc-project-dropdown {
    position: absolute;
    bottom: calc(100% + 4px);
    left: 0;
    background: var(--color-surface);
    border: 1px solid var(--color-rule);
    border-radius: 6px;
    padding: 4px;
    min-width: 200px;
    z-index: 20;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.18);
}
.nc-project-option {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 10px;
    border-radius: 4px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--color-ink-2);
    text-align: left;
}
.nc-project-option:hover {
    background: var(--color-chrome-high);
    color: var(--color-ink);
}
.nc-project-option.selected {
    background: var(--color-accent-tint);
    color: var(--color-accent);
    font-weight: 600;
}
.nc-project-path {
    margin-left: auto;
    font-size: 10px;
    color: var(--color-ink-3);
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
}

/* Approval picker */
.approval-picker {
    position: relative;
}
.approval-trigger {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-family: var(--font-sans);
    font-size: 10.5px;
    color: var(--color-ink-3);
    padding: 3px 7px;
    border-radius: 4px;
    text-transform: capitalize;
}
.approval-trigger:hover {
    color: var(--color-ink-2);
    background: var(--color-chrome-high);
}
.approval-menu {
    position: absolute;
    bottom: calc(100% + 4px);
    left: 0;
    background: var(--color-surface);
    border: 1px solid var(--color-rule);
    border-radius: 6px;
    padding: 4px;
    min-width: 180px;
    z-index: 20;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.18);
}
.approval-option {
    display: flex;
    flex-direction: column;
    gap: 1px;
    width: 100%;
    padding: 6px 10px;
    border-radius: 4px;
    text-align: left;
}
.approval-option:hover {
    background: var(--color-chrome-high);
}
.approval-option.selected {
    background: var(--color-accent-tint);
}
.approval-option-name {
    font-family: var(--font-sans);
    font-size: 11.5px;
    font-weight: 500;
    color: var(--color-ink-2);
    text-transform: capitalize;
}
.approval-option.selected .approval-option-name {
    color: var(--color-accent);
    font-weight: 600;
}
.approval-danger .approval-option-name {
    color: var(--color-rem);
}
.approval-option.approval-danger.selected {
    background: color-mix(in srgb, var(--color-rem) 8%, transparent);
}
.approval-option.approval-danger.selected .approval-option-name {
    color: var(--color-rem);
}
.approval-trigger--danger {
    color: var(--color-rem);
}
.approval-trigger--danger:hover {
    color: var(--color-rem);
}
.approval-option-desc {
    font-family: var(--font-sans);
    font-size: 10px;
    color: var(--color-ink-3);
}

/* Drop-item styles for app overlay */
.nc-drop-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 10px;
    border-radius: 6px;
    width: 100%;
    text-align: left;
}
.nc-drop-item:hover {
    background: var(--color-chrome-high);
}
.nc-drop-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--color-ink-3);
}
.nc-drop-meta {
    flex: 1;
    min-width: 0;
}
.nc-drop-name {
    font-family: var(--font-sans);
    font-size: 12.5px;
    font-weight: 500;
    color: var(--color-ink);
}
.nc-drop-desc {
    font-family: var(--font-sans);
    font-size: 11px;
    color: var(--color-ink-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

/* App grid */
.nc-apps-section {
    width: 100%;
    padding: 40px 4px 0;
}
.nc-apps-label {
    font-family: var(--font-sans);
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    color: var(--color-ink-3);
    padding: 0 0 8px;
}
.nc-apps-grid {
    display: flex;
    gap: 8px;
}
.nc-app-card {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 10px 12px;
    border-radius: 8px;
    background: var(--color-surface);
    border: 1px solid var(--color-rule-light);
    text-align: left;
}
.nc-app-card:hover {
    border-color: var(--color-rule);
    background: var(--color-chrome);
}
.nc-app-icon {
    font-size: 16px;
    line-height: 1;
    flex-shrink: 0;
    margin-top: 1px;
}
.nc-app-icon-default {
    color: var(--color-ink-3);
    font-size: 12px;
}
.nc-app-meta {
    flex: 1;
    min-width: 0;
}
.nc-app-name {
    font-family: var(--font-sans);
    font-size: 12px;
    font-weight: 500;
    color: var(--color-ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.nc-app-desc {
    font-family: var(--font-sans);
    font-size: 10.5px;
    color: var(--color-ink-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-top: 2px;
}

.nc-apps-more-wrap {
    position: relative;
}
.nc-apps-more {
    font-family: var(--font-sans);
    font-size: 11px;
    color: var(--color-ink-3);
    padding: 6px 4px 0;
}
.nc-apps-more:hover {
    color: var(--color-ink);
}

.nc-apps-overlay {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    background: var(--color-surface);
    border: 1px solid var(--color-rule);
    border-radius: 10px;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.15);
    max-height: 280px;
    overflow-y: auto;
    padding: 4px;
    z-index: 20;
    min-width: 260px;
}
</style>
