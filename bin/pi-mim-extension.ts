import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const endpoint = process.env.MIMX_MCP_URL || "http://127.0.0.1:17532/mcp";

async function request(method: string, params: Record<string, unknown>, signal?: AbortSignal) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      method,
      params,
    }),
    signal,
  });
  if (!response.ok) throw new Error(`Mim returned HTTP ${response.status}.`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || "Mim tool request failed.");
  return payload.result;
}

export default function mimTools(pi: ExtensionAPI) {
  const registered = new Set<string>();

  async function discover() {
    const result = await request("tools/list", {});
    for (const definition of result?.tools || []) {
      if (!definition?.name) continue;
      const toolName = `mim_${definition.name}`;
      if (registered.has(toolName)) continue;
      registered.add(toolName);
      pi.registerTool({
        name: toolName,
        label: `Mim · ${definition.name.replace(/_/g, " ")}`,
        description: definition.description || `Call the Mim ${definition.name} capability.`,
        parameters: Type.Unsafe(definition.inputSchema || {
          type: "object",
          properties: {},
          additionalProperties: true,
        }),
        promptSnippet: `Use ${toolName} to work through the attached Mim workbench.`,
        async execute(_toolCallId, params, signal) {
          const response = await request("tools/call", {
            name: definition.name,
            arguments: params || {},
          }, signal);
          const text = response?.content?.[0]?.text
            || JSON.stringify(response?.structuredContent ?? null, null, 2);
          if (response?.isError) throw new Error(text);
          return {
            content: [{ type: "text", text }],
            details: response?.structuredContent ?? null,
          };
        },
      });
    }
  }

  pi.on("session_start", async () => {
    await discover();
  });

  pi.registerCommand("mim-refresh", {
    description: "Discover tools currently exposed by the attached Mim workbench.",
    async handler(_args, ctx) {
      await discover();
      if (ctx.hasUI) ctx.ui.notify(`Mim tools ready (${registered.size})`, "info");
    },
  });
}
