import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { z } from 'zod'
import { createMimTools } from './ai/tools/index.js'
import { getToolMeta } from './ai/tools/gate.js'

const TOOL_SERVER_ALLOWLIST = new Set([
  'read', 'list', 'search', 'edit', 'create', 'comment_add', 'comment_reply',
  'search_web', 'annotate_docx', 'show', 'shell',
  'editor_open', 'editor_active', 'editor_tabs', 'editor_content',
  'editor_selection', 'editor_comments', 'editor_replace_selection', 'editor_set_content',
  'editor_reveal', 'editor_save',
])

let unlisten = null

export async function initToolServer(findProjectFn, editorController = null) {
  unlisten = await listen('tool-call-request', async (event) => {
    const { id, tool, input, cwd } = event.payload
    try {
      if (tool === '__schema__') {
        const schema = generateToolSchema()
        await invoke('tool_call_response', { id, result: schema, error: null })
        return
      }

      if (!TOOL_SERVER_ALLOWLIST.has(tool)) {
        await invoke('tool_call_response', { id, result: null, error: `Tool '${tool}' is not available via the tool server.` })
        return
      }

      if (tool.startsWith('editor_')) {
        const result = await executeEditorTool(editorController, tool, input || {})
        await invoke('tool_call_response', { id, result, error: null })
        return
      }

      const project = findProjectFn(cwd)
      const context = {
        sessionId: 'tool-server',
        projectId: project?.id || 'general',
        projectPath: project?.workspacePath || null,
        disabledTools: [],
        approvalMode: 'bypass',
        getDocument: () => null,
        onApprovalRequest: null,
        policy: {},
        onProposal: () => {},
      }

      const tools = createMimTools(context)
      if (!tools[tool]) {
        await invoke('tool_call_response', { id, result: null, error: `Tool '${tool}' not found.` })
        return
      }

      const result = await tools[tool].execute(input)
      await invoke('tool_call_response', { id, result, error: null })
    } catch (err) {
      await invoke('tool_call_response', { id, result: null, error: err.message || String(err) })
    }
  })
}

export function destroyToolServer() {
  if (unlisten) {
    unlisten()
    unlisten = null
  }
}

function generateToolSchema() {
  const context = {
    sessionId: 'tool-server',
    projectId: 'general',
    projectPath: null,
    disabledTools: [],
    approvalMode: 'bypass',
    getDocument: () => null,
    onApprovalRequest: null,
    policy: {},
    onProposal: () => {},
  }

  const tools = createMimTools(context)
  const schema = []

  for (const name of TOOL_SERVER_ALLOWLIST) {
    if (name.startsWith('editor_')) {
      schema.push(editorToolSchema(name))
      continue
    }
    const t = tools[name]
    if (!t) continue
    const meta = getToolMeta(name)
    let input_schema = { type: 'object' }
    try {
      input_schema = z.toJSONSchema(t.inputSchema)
    } catch {}
    schema.push({
      name,
      description: t.description || meta.description || '',
      input_schema,
    })
  }

  return schema
}

async function executeEditorTool(editor, tool, input) {
  if (!editor) throw new Error('No editor is attached to the tool server.')
  switch (tool) {
    case 'editor_open':
      return await editor.mimOpen(input.path)
    case 'editor_active':
      return editor.mimActive({ includeContent: Boolean(input.includeContent) })
    case 'editor_tabs':
      return editor.mimTabs()
    case 'editor_content':
      return editor.mimActive({ includeContent: true })
    case 'editor_selection':
      return editor.mimSelection()
    case 'editor_comments':
      return editor.mimComments()
    case 'editor_replace_selection':
      return editor.mimReplaceSelection(input.text || '')
    case 'editor_set_content':
      return editor.mimSetContent(input.content || '')
    case 'editor_reveal':
      return editor.mimReveal(input)
    case 'editor_save':
      return await editor.mimSave()
    default:
      throw new Error(`Unknown editor tool '${tool}'.`)
  }
}

function editorToolSchema(name) {
  const schemas = {
    editor_open: {
      description: 'Open a file path in the attached editor.',
      input_schema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
    },
    editor_active: {
      description: 'Return the active editor tab metadata.',
      input_schema: { type: 'object', properties: { includeContent: { type: 'boolean' } } },
    },
    editor_tabs: {
      description: 'List open editor tabs.',
      input_schema: { type: 'object', properties: {} },
    },
    editor_content: {
      description: 'Return the active editor tab metadata and full content.',
      input_schema: { type: 'object', properties: {} },
    },
    editor_selection: {
      description: 'Return the active editor selection text and offsets.',
      input_schema: { type: 'object', properties: {} },
    },
    editor_comments: {
      description: 'Return inline pseudo-XML comments for the active editor file plus an agent prompt.',
      input_schema: { type: 'object', properties: {} },
    },
    editor_replace_selection: {
      description: 'Replace the active editor selection with text.',
      input_schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    },
    editor_set_content: {
      description: 'Replace the full active editor document content.',
      input_schema: { type: 'object', required: ['content'], properties: { content: { type: 'string' } } },
    },
    editor_reveal: {
      description: 'Reveal a path, line, or offset in the attached editor.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          line: { type: 'number' },
          offset: { type: 'number' },
        },
      },
    },
    editor_save: {
      description: 'Save the active editor file.',
      input_schema: { type: 'object', properties: {} },
    },
  }
  return {
    name,
    description: schemas[name]?.description || '',
    input_schema: schemas[name]?.input_schema || { type: 'object' },
  }
}
