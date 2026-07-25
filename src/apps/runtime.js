import { generateText, stepCountIs, jsonSchema } from 'ai'
import { invoke } from '@tauri-apps/api/core'
import { createSdkModel, buildProviderOptions, normalizeSdkUsage, addUsage } from '../services/ai/sdkAdapter'
import { readDocxAsText } from '../services/docx/reader'
import { annotateDocx } from '../services/docx/writer'

/**
 * Normalize app tool definitions for the Vercel AI SDK.
 * App tools use plain JSON Schema `parameters` + `execute`,
 * but AI SDK v6 expects `inputSchema` (a FlexibleSchema) + `execute`.
 */
function normalizeTools(tools) {
  if (!tools) return tools
  const normalized = {}
  for (const [name, def] of Object.entries(tools)) {
    if (def.inputSchema) {
      normalized[name] = def
    } else if (def.parameters) {
      normalized[name] = {
        description: def.description,
        inputSchema: jsonSchema(def.parameters),
        execute: def.execute,
      }
    } else {
      normalized[name] = def
    }
  }
  return normalized
}

export function createAppRuntime(app, { onProgress, signal, project = null, inputs = {}, docxPath = null } = {}) {
  let totalUsage = null

  function trackUsage(stepUsage, modelConfig) {
    const normalized = normalizeSdkUsage(stepUsage, modelConfig)
    totalUsage = totalUsage ? addUsage(totalUsage, normalized) : normalized
  }

  const appId = app.id
  const projectId = project?.id || 'general'

  const ctx = {
    inputs: Object.freeze({ ...inputs }),

    project: project ? {
      id: project.id,
      name: project.name,
      path: project.path || '',
      workspacePath: project.workspacePath || null,
      system: Boolean(project.system),
    } : null,

    // ── Model ───────────────────────────────────────────────────
    model: {
      async generate({
        model: modelId = null,
        system,
        prompt,
        messages,
        tools,
        maxSteps = 8,
        maxOutputTokens = 4096,
        temperature = 0.3,
        responseFormat,
        controlId,
      }) {
        const { model, modelConfig } = await createSdkModel({
          modelId,
          feature: 'chat',
          correlationPrefix: 'app',
        })

        const opts = {
          model,
          maxOutputTokens,
          temperature,
          providerOptions: buildProviderOptions(modelConfig, controlId),
          onStepFinish(event) {
            if (event.usage) trackUsage(event.usage, modelConfig)
          },
        }

        if (system) opts.system = system
        if (prompt) opts.prompt = prompt
        if (messages) opts.messages = messages
        if (tools) {
          opts.tools = normalizeTools(tools)
          opts.stopWhen = stepCountIs(Math.min(Math.max(maxSteps, 1), 25))
        }
        if (responseFormat === 'json') {
          opts.providerOptions = {
            ...opts.providerOptions,
            anthropic: {
              ...opts.providerOptions?.anthropic,
            },
          }
        }
        if (signal) opts.abortSignal = signal

        const result = await generateText(opts)
        return result
      },

      async create(modelId) {
        return createSdkModel({ modelId, feature: 'chat', correlationPrefix: 'app' })
      },
    },

    // ── Data (persistent key-value, project-scoped) ─────────────
    data: {
      async load(key) {
        const raw = await invoke('app_data_load', { appId, projectId, key })
        return raw != null ? JSON.parse(raw) : null
      },
      async save(key, value) {
        await invoke('app_data_save', { appId, projectId, key, value: JSON.stringify(value) })
      },
      async delete(key) {
        await invoke('app_data_delete', { appId, projectId, key })
      },
      async keys() {
        return invoke('app_data_keys', { appId, projectId })
      },
    },

    // ── DOCX ────────────────────────────────────────────────────
    docx: {
      connected() {
        return !!docxPath
      },

      async read() {
        const path = docxPath
        if (!path) throw new Error('No DOCX file selected')
        const markdown = await readDocxAsText(path)
        return { markdown, text: markdown }
      },

      async comment(anchorText, text, author) {
        if (!docxPath) throw new Error('No DOCX file selected')
        if (!ctx._pendingComments) ctx._pendingComments = []
        ctx._pendingComments.push({ anchorText, text, author })
        return { success: true, mode: 'batched' }
      },

      async flushComments() {
        if (!docxPath || !ctx._pendingComments?.length) return { inserted: 0 }
        const strip = s => s
          .replace(/\*\*(.+?)\*\*/g, '$1')
          .replace(/\*(.+?)\*/g, '$1')
          .replace(/^#{1,6}\s+/gm, '')
          .replace(/^[-*]\s+/gm, '')
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        const ops = ctx._pendingComments.map(c => ({
          type: 'add_comment',
          anchorText: strip(c.anchorText),
          commentText: c.text,
          author: c.author || 'mim',
        }))
        ctx._pendingComments = []
        const result = await annotateDocx(docxPath, ops)
        console.log('[app] flushComments result:', JSON.stringify(result))
        return result
      },
    },

    // ── Knowledge ───────────────────────────────────────────────
    knowledge: {
      async load(relativePath) {
        const basePath = await getAppBasePath(appId)
        const fullPath = `${basePath}/knowledge/${relativePath}`
        const { content } = await invoke('read_text_file', { path: fullPath })
        return content
      },

      async loadAll(dir = '') {
        const basePath = await getAppBasePath(appId)
        const fullDir = dir
          ? `${basePath}/knowledge/${dir}`
          : `${basePath}/knowledge`
        const exists = await invoke('path_exists', { path: fullDir })
        if (!exists) return []
        const entries = await invoke('list_dir', { path: fullDir })
        const results = []
        for (const entry of entries) {
          if (entry.is_dir) continue
          const { content } = await invoke('read_text_file', { path: entry.path })
          results.push({ name: entry.name, content })
        }
        return results
      },
    },

    // ── Progress ────────────────────────────────────────────────
    progress: {
      step(name) {
        onProgress?.({ type: 'step', name, time: Date.now() })
      },
      log(message) {
        onProgress?.({ type: 'log', message, time: Date.now() })
      },
      done(summary) {
        onProgress?.({ type: 'done', summary, time: Date.now(), usage: totalUsage })
      },
    },

    // ── Abort ───────────────────────────────────────────────────
    abort: {
      get signal() { return signal || null },
      get aborted() { return signal?.aborted || false },
      throwIfAborted() {
        if (signal?.aborted) throw new Error('App aborted')
      },
    },

    // ── Files (read from app folder) ────────────────────────────
    files: {
      async read(relativePath) {
        const basePath = await getAppBasePath(appId)
        const fullPath = `${basePath}/${relativePath}`
        const { content } = await invoke('read_text_file', { path: fullPath })
        return content
      },

      async readJson(relativePath) {
        const raw = await ctx.files.read(relativePath)
        return JSON.parse(raw)
      },

      async exists(relativePath) {
        const basePath = await getAppBasePath(appId)
        return invoke('path_exists', { path: `${basePath}/${relativePath}` })
      },
    },

    http: {
      async fetch(url, opts = {}) {
        const result = await invoke('app_http_request', {
          appId,
          url,
          method: opts.method || 'GET',
          headers: opts.headers || null,
          body: opts.body || null,
          timeoutMs: opts.timeout || null,
        })
        return {
          status: result.status,
          headers: result.headers,
          body: result.body,
          get ok() { return result.status >= 200 && result.status < 300 },
          json() { return JSON.parse(result.body) },
        }
      },
    },

    // ── Usage ───────────────────────────────────────────────────
    get usage() {
      return totalUsage
    },
  }

  return ctx
}

// Helper to resolve app base path
let _appBasePathCache = null
async function getAppBasePath(appId) {
  if (_appBasePathCache) return `${_appBasePathCache}/${appId}`
  const home = await getHomeDir()
  _appBasePathCache = `${home}/.mim/apps`
  return `${_appBasePathCache}/${appId}`
}

async function getHomeDir() {
  try {
    const { homeDir } = await import('@tauri-apps/api/path')
    return await homeDir()
  } catch {
    return process.env.HOME || process.env.USERPROFILE || '/tmp'
  }
}
