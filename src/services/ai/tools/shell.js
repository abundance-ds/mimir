import { tool } from 'ai'
import { z } from 'zod'
import { withGate } from './gate'
import { limitText } from './helpers'

export function createShellTool(context) {
  const workspacePath = context.workspacePath || context.projectPath || null
  const gateCtx = {
    sessionId: context.sessionId,
    policy: context.policy,
    onApprovalRequest: context.onApprovalRequest,
    projectPath: workspacePath,
    approvalMode: context.approvalMode,
  }

  if (!workspacePath) return {}

  return {
    shell: tool({
      description:
        'Execute a shell command in the project directory. Returns stdout, stderr, and exit code. ' +
        'Runs in bash with the user\'s PATH. Requires user approval. ' +
        'Avoid interactive commands (vim, less, top) — they will hang.',
      inputSchema: z.object({
        command: z.string().min(1).max(2000).describe('Shell command to execute'),
        cwd: z.string().max(500).optional().describe('Working directory (relative to project or absolute)'),
        timeout: z.number().int().min(1).max(120).optional().describe('Timeout in seconds, default 30'),
      }),
      execute: withGate('shell', async ({ command, cwd, timeout = 30 }) => {
        let resolvedCwd = workspacePath
        if (cwd) {
          if (cwd.startsWith('/')) {
            resolvedCwd = cwd
          } else {
            resolvedCwd = workspacePath + '/' + cwd
          }
        }

        try {
          const { invoke } = await import('@tauri-apps/api/core')
          const result = await invoke('shell_exec', {
            command,
            workingDir: resolvedCwd,
            timeoutMs: timeout * 1000,
          })

          const output = {
            exit_code: result.exit_code,
            timed_out: result.timed_out,
            duration_ms: result.duration_ms,
          }

          if (result.stdout) {
            output.stdout = limitText(result.stdout, 20_000)
          }
          if (result.stderr) {
            output.stderr = limitText(result.stderr, 8_000)
          }
          if (result.timed_out) {
            output.note = `Command timed out after ${timeout}s and was killed.`
          }

          return output
        } catch (e) {
          return { error: `Command failed: ${e?.message || e}` }
        }
      }, gateCtx),
    }),
  }
}
