import { ref } from 'vue'
import { defineStore } from 'pinia'
import { defaultProjects, basename } from './helpers.js'

const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

export const useProjectStore = defineStore('panelProjects', () => {
  const projects = ref(defaultProjects())
  const expandedProjectIds = ref([])
  const projectFileIndex = ref([])

  // ---- Expansion ----

  function expandProject(id) {
    if (!expandedProjectIds.value.includes(id)) expandedProjectIds.value.push(id)
  }

  function toggleProject(id) {
    if (expandedProjectIds.value.includes(id)) {
      expandedProjectIds.value = expandedProjectIds.value.filter((x) => x !== id)
    } else {
      expandProject(id)
    }
  }

  function projectExpanded(id) {
    return expandedProjectIds.value.includes(id)
  }

  function collapseAllProjects() {
    expandedProjectIds.value = []
  }

  // ---- Path resolution ----

  function resolveProjectPath(projectId) {
    const project = projects.value.find((p) => p.id === projectId)
    const p = project?.workspacePath || project?.path
    return p && p.startsWith('/') ? p : null
  }

  function findProjectByFilePath(filePath) {
    if (!filePath) return null
    return projects.value.find(p => {
      const projPath = p.workspacePath || p.path
      return projPath && projPath.startsWith('/') && filePath.startsWith(projPath + '/')
    }) || null
  }

  // ---- Project list helpers ----

  function insertProject(project) {
    const generalIndex = projects.value.findIndex((p) => p.id === 'general')
    const insertAt = generalIndex >= 0 ? generalIndex + 1 : 0
    projects.value.splice(insertAt, 0, project)
  }

  function orderProjects(projectList, order = []) {
    const byId = new Map(projectList.map((p) => [p.id, p]))
    const ordered = []
    const general = byId.get('general')
    if (general) {
      ordered.push(general)
      byId.delete('general')
    }
    if (Array.isArray(order)) {
      order.forEach((id) => {
        if (id === 'general' || !byId.has(id)) return
        ordered.push(byId.get(id))
        byId.delete(id)
      })
    }
    ordered.push(...byId.values())
    return ordered
  }

  function mergeProjects(saved) {
    const byId = new Map(defaultProjects().map((p) => [p.id, p]))
    if (Array.isArray(saved)) {
      saved.forEach((p) => { if (p?.id && p?.name) byId.set(p.id, p) })
    }
    return Array.from(byId.values())
  }

  // ---- Folder / workspace ----

  async function openFolderProject() {
    if (!isTauri) return null
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({ directory: true, multiple: false, title: 'Open project folder' })
      if (!selected) return null
      const workspacePath = Array.isArray(selected) ? selected[0] : selected
      if (!workspacePath) return null

      const existing = await checkFolderForExistingProject(workspacePath)
      if (existing) {
        expandProject(existing.id)
        return existing
      }

      const name = basename(workspacePath) || 'Untitled Project'
      return linkFolderAsProject({ name, workspacePath })
    } catch (error) {
      console.warn('[panel] Could not open project folder:', error)
      return null
    }
  }

  async function linkFolderAsProject({ name, workspacePath }) {
    const existing = workspacePath
      ? projects.value.find((p) => p.workspacePath === workspacePath)
      : null
    if (existing) {
      expandProject(existing.id)
      return existing
    }

    const id = `project_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const project = {
      id,
      name: (name || '').trim() || basename(workspacePath) || 'Untitled Project',
      workspacePath: workspacePath || null,
      path: workspacePath || 'Local project',
      createdAt: new Date().toISOString(),
      system: false,
    }
    if (workspacePath && isTauri) {
      const { writeShoulderMarker } = await import('../../services/dataDir')
      await writeShoulderMarker(workspacePath, { projectId: id, name })
    }
    insertProject(project)
    expandProject(id)
    return project
  }

  async function checkFolderForExistingProject(folderPath) {
    const existingByPath = projects.value.find((p) => p.workspacePath === folderPath)
    if (existingByPath) return existingByPath
    if (!isTauri) return null
    const { readShoulderMarker } = await import('../../services/dataDir')
    const marker = await readShoulderMarker(folderPath)
    if (!marker) return null
    return projects.value.find(p => p.id === marker.projectId) || null
  }

  // ---- Rename / Remove ----

  async function renameProject(projectId, newName) {
    const project = projects.value.find(p => p.id === projectId)
    if (!project || projectId === 'general' || !newName.trim()) return
    project.name = newName.trim()
    if (project.workspacePath && isTauri) {
      const { writeShoulderMarker } = await import('../../services/dataDir')
      await writeShoulderMarker(project.workspacePath, { projectId: project.id, name: project.name })
    }
  }

  async function removeProject(projectId) {
    const project = projects.value.find(p => p.id === projectId)
    if (!project || projectId === 'general') return
    if (project.workspacePath && isTauri) {
      const { deleteShoulderMarker } = await import('../../services/dataDir')
      try { await deleteShoulderMarker(project.workspacePath) } catch {}
    }
    if (isTauri) {
      const { deleteProjectDir } = await import('../../services/dataDir')
      try { await deleteProjectDir(projectId) } catch {}
    }
    projects.value = projects.value.filter(p => p.id !== projectId)
  }

  // ---- File indexing ----

  async function indexProjectFiles(workspacePath) {
    if (!workspacePath || !isTauri) {
      projectFileIndex.value = []
      return
    }
    try {
      const { indexProjectFiles: doIndex } = await import('../../services/dataDir')
      projectFileIndex.value = await doIndex(workspacePath)
    } catch (e) {
      console.warn('[panel] file indexing failed:', e)
      projectFileIndex.value = []
    }
  }

  return {
    projects,
    expandedProjectIds,
    projectFileIndex,
    expandProject,
    toggleProject,
    projectExpanded,
    collapseAllProjects,
    resolveProjectPath,
    findProjectByFilePath,
    insertProject,
    orderProjects,
    mergeProjects,
    openFolderProject,
    linkFolderAsProject,
    checkFolderForExistingProject,
    renameProject,
    removeProject,
    indexProjectFiles,
  }
})
