import { invoke } from '@tauri-apps/api/core'
import { getDataDir } from '../dataDir'

export function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { meta: {}, body: raw }

  const yamlBlock = match[1]
  const body = match[2]
  const meta = {}

  for (const line of yamlBlock.split('\n')) {
    const m = line.match(/^(\w+)\s*:\s*(.+)$/)
    if (!m) continue
    let val = m[2].trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    const key = m[1]
    if (key === 'maxSteps' || key === 'maxOutputTokens') {
      const n = Number(val)
      if (!isNaN(n)) val = n
    }
    meta[key] = val
  }

  return { meta, body }
}

export async function skillsDir() {
  return `${await getDataDir()}/skills`
}

async function exists(path) {
  return invoke('path_exists', { path })
}

export async function discoverSkills() {
  const dir = await skillsDir()
  if (!await exists(dir)) return []

  const entries = await invoke('list_dir', { path: dir })
  const skills = []

  for (const entry of entries) {
    if (!entry.is_dir) continue
    const skillPath = `${entry.path}/SKILL.md`
    if (!await exists(skillPath)) continue

    const { content } = await invoke('read_text_file', { path: skillPath })
    const { meta } = parseFrontmatter(content)

    skills.push({
      id: entry.name,
      name: meta.name || entry.name,
      description: meta.description || '',
      maxSteps: meta.maxSteps,
      maxOutputTokens: meta.maxOutputTokens,
      path: entry.path,
    })
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

export async function readSkillPrompt(skillId) {
  const dir = await skillsDir()
  const path = `${dir}/${skillId}/SKILL.md`
  const { content } = await invoke('read_text_file', { path })
  const { body } = parseFrontmatter(content)
  return body
}

export async function ensureSkillsDir() {
  const dir = await skillsDir()
  await invoke('create_dir', { path: dir })
  return dir
}

export async function seedDefaultSkills(bundled) {
  const dir = await skillsDir()
  await invoke('create_dir', { path: dir })

  for (const { id, content } of bundled) {
    const dest = `${dir}/${id}`
    if (await exists(dest)) continue
    await invoke('create_dir', { path: dest })
    await invoke('write_text_file', { path: `${dest}/SKILL.md`, content })
  }
}

export async function seedSkillFromResource(id, content) {
  const dir = await skillsDir()
  const dest = `${dir}/${id}`
  if (await exists(dest)) return
  await invoke('create_dir', { path: dest })
  await invoke('write_text_file', { path: `${dest}/SKILL.md`, content })
}

export async function importSkillFromFolder(sourcePath) {
  const dir = await skillsDir()
  await invoke('create_dir', { path: dir })

  const name = sourcePath.split('/').pop()
  const skillPath = `${sourcePath}/SKILL.md`
  if (!await exists(skillPath)) {
    throw new Error(`Folder "${name}" does not contain a SKILL.md file.`)
  }

  const destPath = `${dir}/${name}`
  if (await exists(destPath)) {
    throw new Error(`Skill "${name}" already exists. Remove it first or choose a different folder.`)
  }

  await invoke('copy_dir', { src: sourcePath, dest: destPath })
  return destPath
}

export async function importSkillFromFile(filePath) {
  const dir = await skillsDir()
  await invoke('create_dir', { path: dir })

  const fileName = filePath.split('/').pop()
  const skillId = fileName.replace(/\.md$/i, '').toLowerCase().replace(/[^a-z0-9-]/g, '-')
  const destPath = `${dir}/${skillId}`

  if (await exists(destPath)) {
    throw new Error(`Skill "${skillId}" already exists.`)
  }

  await invoke('create_dir', { path: destPath })
  const { content } = await invoke('read_text_file', { path: filePath })
  await invoke('write_text_file', { path: `${destPath}/SKILL.md`, content })
  return destPath
}

export async function createSkillTemplate(skillId) {
  const dir = await skillsDir()
  await invoke('create_dir', { path: dir })

  const destPath = `${dir}/${skillId}`
  await invoke('create_dir', { path: destPath })

  const template = `---
name: ${skillId}
description: A new skill
---

<skill name="${skillId}">
Your instructions here.
</skill>`

  await invoke('write_text_file', { path: `${destPath}/SKILL.md`, content: template })
  return destPath
}

export async function removeSkill(skillId) {
  const dir = await skillsDir()
  const path = `${dir}/${skillId}`
  if (await exists(path)) {
    await invoke('delete_path', { path })
  }
}
