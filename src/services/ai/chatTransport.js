import { DirectChatTransport, ToolLoopAgent, stepCountIs } from 'ai'
import { createSdkModel, buildProviderOptions, normalizeSdkUsage } from './sdkAdapter'
import { createMimTools } from './tools'
import { mapAiError } from './errors'
import { buildInstructions } from './systemPrompt'

export function createMimChatTransport(getConfig) {
  return {
    async sendMessages({ messages, abortSignal }) {
      try {
        const config = await getConfig()
        const { model, modelConfig } = await createSdkModel({
          modelId: config.modelId,
          feature: 'chat',
          correlationPrefix: config.threadId || 'chat',
          registry: config.registry,
        })

        const instructions = buildInstructions(config)

        const recentCalls = []
        const agent = new ToolLoopAgent({
          model,
          instructions,
          tools: createMimTools(config.toolContext),
          stopWhen: stepCountIs(Math.min(Math.max(config.maxSteps || 50, 1), 100)),
          providerOptions: buildProviderOptions(modelConfig, config.controlId),
          onStepFinish(event) {
            if (event.usage) {
              config.onUsage?.(normalizeSdkUsage(event.usage, modelConfig), modelConfig)
            }
            if (event.toolCalls?.length) {
              for (const tc of event.toolCalls) {
                recentCalls.push({ name: tc.toolName, args: JSON.stringify(tc.args) })
                if (recentCalls.length > 3) recentCalls.shift()
              }
              if (recentCalls.length === 3
                && recentCalls[0].name === recentCalls[1].name && recentCalls[1].name === recentCalls[2].name
                && recentCalls[0].args === recentCalls[1].args && recentCalls[1].args === recentCalls[2].args) {
                throw new Error(`Tool loop detected: ${recentCalls[0].name} called 3 times with identical arguments`)
              }
            }
          },
        })

        const transport = new DirectChatTransport({ agent, sendReasoning: true })
        return transport.sendMessages({ messages, abortSignal })
      } catch (err) {
        const mapped = mapAiError(err)
        const wrapped = new Error(mapped.message)
        wrapped.cause = err
        wrapped.kind = mapped.kind
        throw wrapped
      }
    },

    async reconnectToStream() {
      throw new Error('Stream reconnection is not supported in mim terminal chat transport')
    },
  }
}
