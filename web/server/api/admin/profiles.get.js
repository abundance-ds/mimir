import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export default defineEventHandler(() => {
  const profilesDir = join(process.cwd(), '..', 'profiles')

  if (!existsSync(profilesDir)) return []

  return readdirSync(profilesDir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const data = JSON.parse(readFileSync(join(profilesDir, f), 'utf8'))
        return {
          filename: f,
          name: data.name || f.replace('.json', ''),
          skills: data.skills || [],
          apps: data.apps || [],
          bundleSkills: data.bundleSkills || [],
        }
      } catch {
        return { filename: f, name: f.replace('.json', ''), skills: [], apps: [], bundleSkills: [] }
      }
    })
})
