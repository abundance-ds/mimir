import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const endpoint = process.env.MIMIR_MCP_URL || "http://127.0.0.1:17532/mcp";
const instruction = "Mimir: On the first substantive user turn, call `mimir_title` once with a concise 3-8 word task title. Discover other capabilities with `mimir tools` (all), `mimir tools <workbench|graph|chat|connections>`, `mimir tool <name>`, `mimir skill <query>`, and `mimir doctor`.";
let protocolVersion: string | undefined;

async function request(
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
  notification = false,
) {
  const timeout = AbortSignal.timeout(10_000);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...(notification ? {} : {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      }),
      method,
      params,
    }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`Mimir returned HTTP ${response.status}.`);
  if (notification) return undefined;
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || "Mimir tool request failed.");
  return payload.result;
}

export default function mimirTools(pi: ExtensionAPI) {
  const registered = new Set<string>();

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: event.systemPrompt.includes(instruction)
      ? event.systemPrompt
      : `${event.systemPrompt}\n\n${instruction}`,
  }));

  async function discover() {
    const result = await request("tools/list", {});
    for (const definition of result?.tools || []) {
      if (!definition?.name) continue;
      const toolName = definition.name.startsWith("mimir_")
        ? definition.name
        : `mimir_${definition.name}`;
      if (registered.has(toolName)) continue;
      registered.add(toolName);
      pi.registerTool({
        name: toolName,
        label: `Mimir · ${definition.name.replace(/_/g, " ")}`,
        description: definition.description || `Call the Mimir ${definition.name} capability.`,
        parameters: Type.Unsafe(definition.inputSchema || {
          type: "object",
          properties: {},
          additionalProperties: true,
        }),
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

  async function connect() {
    if (!protocolVersion) {
      const initialized = await request("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "mimir-pi", version: "0.1.0" },
      });
      protocolVersion = initialized?.protocolVersion;
      await request("notifications/initialized", {}, undefined, true);
    }
  }

  pi.on("session_start", async () => {
    await connect();
    await discover();
  });

  pi.registerCommand("mimir-refresh", {
    description: "Discover tools currently exposed by the attached Mimir workbench.",
    async handler(_args, ctx) {
      await connect();
      await discover();
      if (ctx.hasUI) ctx.ui.notify(`Mimir tools ready (${registered.size})`, "info");
    },
  });
}
