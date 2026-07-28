import { createReadTool } from './read'
import { createListTool } from './list'
import { createSearchTool } from './search'
import { createEditTool } from './edit'
import { createCreateTool } from './create'
import { createCommentAddTool } from './commentAdd'
import { createCommentReplyTool } from './commentReply'
import { createSearchWebTool } from './searchWeb'
import { createShellTool } from './shell'
import { limitText, MAX_TOOL_OUTPUT_CHARS } from './helpers'

export { limitText, MAX_TOOL_OUTPUT_CHARS }

export function createMimirTools(context = {}) {
  const tools = {
    ...createReadTool(context),
    ...createListTool(context),
    ...createSearchTool(context),
    ...createEditTool(context),
    ...createCreateTool(context),
    ...createCommentAddTool(context),
    ...createCommentReplyTool(context),
    ...createSearchWebTool(context),
    ...createShellTool(context),
  }

  if (context.disabledTools?.length) {
    for (const name of context.disabledTools) delete tools[name]
  }

  return tools
}
