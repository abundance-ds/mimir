import { DirectChatTransport, ToolLoopAgent, stepCountIs } from 'ai'
import { tool } from 'ai'
import { z } from 'zod'
import { createSdkModel, buildProviderOptions, normalizeSdkUsage } from './sdkAdapter'
import { createReadTool } from './tools/read'
import { createSearchTool } from './tools/search'
import { escapePromptXml } from './context'

function buildInlineTools(ctx, onEdit) {
  const readTools = createReadTool(ctx)
  const searchTools = createSearchTool(ctx)

  const tools = {}
  if (readTools.read) tools.read = readTools.read
  if (searchTools.search) tools.search = searchTools.search

  tools.suggest_edit = tool({
      description: 'Suggest replacement text for the selected text. Call this when the user asks to modify, rewrite, shorten, expand, or otherwise change their selection.',
      inputSchema: z.object({
        replacement: z.string().describe('The full replacement text for the selection'),
      }),
      execute: async ({ replacement }) => {
        onEdit?.({ replacement })
        return 'Edit suggested. Now explain what you changed and why in 1-2 sentences.'
      },
    })

  return tools
}

export function buildInlineSystemPrompt({ text, contextBefore, contextAfter }) {
  const parts = [
    'You are an inline writing assistant in Shoulders Editor, used by senior research professionals.',
    '',
    'The user selected text in their document. Here is the selection and surrounding context:',
    '',
    `<context-before>${escapePromptXml(contextBefore)}</context-before>`,
    text ? `<selection>${escapePromptXml(text)}</selection>` : '<cursor-position>The cursor is here. No text is selected.</cursor-position>',
    `<context-after>${escapePromptXml(contextAfter)}</context-after>`,
    '',
    'Guidelines:',
    '- When asked to modify text, call suggest_edit with the replacement. Then explain what you changed in 1-2 sentences.',
    '- When asked to insert text (no selection), call suggest_edit with the text to insert.',
    '- When asked a question, answer directly. Use read("@editor") if you need more context.',
    '- Be precise and concise. These are senior researchers.',
  ]
  return parts.join('\n')
}

export function createInlineAITransport(getConfig) {
  return {
    async sendMessages({ messages, abortSignal }) {
      const config = await getConfig()
      const { model, modelConfig } = await createSdkModel({
        modelId: config.modelId,
        feature: 'inline',
        correlationPrefix: 'inline-ai',
        registry: config.registry,
      })

      const tools = buildInlineTools(config.toolContext, config.onEdit)

      const agent = new ToolLoopAgent({
        model,
        instructions: config.system,
        tools,
        stopWhen: stepCountIs(config.maxSteps || 4),
        maxOutputTokens: config.maxOutputTokens || 2000,
        temperature: config.temperature ?? 0.3,
        providerOptions: buildProviderOptions(modelConfig, config.controlId),
        onStepFinish(event) {
          if (event.usage) config.onUsage?.(normalizeSdkUsage(event.usage, modelConfig), modelConfig)
        },
      })

      const transport = new DirectChatTransport({ agent, sendReasoning: false })
      return transport.sendMessages({ messages, abortSignal })
    },
    async reconnectToStream() {
      throw new Error('Not supported')
    },
  }
}
