# Chats

Status: implemented, 2026-07-29. Review fixes landed the same day (multiline
ingestion, relay fallback, windowed history, read-anchor monotonicity,
file-service hardening); re-verify in production after deploying the updated
`file_service.py` and rerunning the protocol tests before calling this
production-verified again.

## Product model

- One stable `chats` Activity owns every room.
- Sidebar: flat room list (`#` / person icons). Selecting a room changes chat state without adding to Activity history.
- `+` means "start a process"; an agent started from a room becomes a normal Activity linked to that room.
- Server speaks IRCv3 (Ergo); UI exposes team language only -- channels, DMs, replies, members, topics, unread, search.
- Show Chats switch (Settings > Chat): off removes sidebar section, disconnects transport, clears dock badge, unregisters the four local chat tools. Does not delete cached history, credentials, channels, server history, or files.

## Everyday interaction

- Unread: one dot per room, aggregate dot on Chats header, dock badge follows total. Muting suppresses alerts, not unread state.
- Cmd/Ctrl+P finds rooms by name/topic when query present; rooms do not crowd default results.
- Dense transcript layout; consecutive messages group. Sender groups open with a monogram chip (robot glyph in accent for agents); hover/focus on a grouped message reveals its gutter timestamp. Message bodies are selectable. One-level replies with jump. Day boundaries, New messages marker, timestamps, agent provenance, code blocks, links.
- Hover/focus message toolbar: one-level reply, five-reaction toggle, inline edit (author, short), deliberate delete confirmation (stable tombstone). Copied `mimir://chat/<target>/<message>` link opens exact cached message.
- File attachments: paperclip / drag-drop / paste. Cards show name, size/type, verified image preview, native open. Downloads cached under `~/.mimir/chat-files/` after size + SHA-256 match.
- Presence: available or away (Ergo marks always-on accounts away on disconnect). DM rows show it on the person icon: filled dot available, hollow away. Typing indicators are ephemeral, never persisted.
- Notifications: focused desktop alerts for incoming DM / direct @mention while not visible. Require explicit Settings > Chat permission. Muting suppresses alerts.
- Composer: one draft + scroll position per room. Enter sends, Shift+Enter newline, single-flight send. Disconnected: history/search available, sending disabled, draft retained.
- Create channel, Join channel, Direct message: three short flows. Known teammates offered first for DMs.

## Agent participation

Start agent in pane header chooses an enabled CLI-agent launcher. Mimir creates
and links the Activity before spawning, gives it a room prompt as editable
terminal input (not submitted -- user appends assignment and presses Enter).

Tools: `chat_rooms`, `chat_read`, `chat_search`, `chat_send`, `chat_download`.
See [agent-interface.md](agent-interface.md) for full signatures;
[mcp.md](mcp.md) for the registry.

- Linked Activity: omitting `target` uses the linked room; explicit `target` reaches any room the user sees. `chat_search` with no resolvable room searches all rooms.
- Agent sends visible as `account/agent` when Ergo relay identity is available (visible-label fallback). Messages carry originating Activity ID when protocol supports it; provenance badge opens that Activity.
- Agent Activity header offers Return to chat.

```bash
mimir call chat_rooms '{}'
mimir call chat_read '{"limit":20}'
mimir call chat_search '{"query":"launch decision","limit":10}'
mimir call chat_send '{"target":"#product","text":"Review complete."}'
mimir call chat_download '{"file_id":"<attachment id from chat_read>"}'
```

## Client architecture

`src-tauri/src/chat/` owns the WebSocket IRCv3 session, SASL, capabilities,
reconnect loop, channel history, membership/presence, validation, authenticated
file transfer, SQLite cache, and native tools. Required capabilities: SASL,
message/account tags, server time, batches, echo, chat/event history,
redaction, account/away notify, extended join. Echo messages make the server
response the canonical local message.

`~/.mimir/chat.sqlite3` -- targets, messages, materialized edits, reactions,
tombstones, attachment metadata, FTS search, unread anchors, member snapshots,
mute/hidden state, Activity links. Cached history available before/without
connection. HistServ bookkeeping filtered from product transcript. See
[persistence.md](persistence.md) for durability contract.

`~/.mimir/chat.json` -- endpoint, account, display name. Credential storage:
macOS release builds use login Keychain (`rs.shoulde.mimir`); debug builds and
other platforms use the repository's atomic secret writer for an owner-only
`~/.mimir/chat.credential`. Debug builds accept `MIMIR_CHAT_PASSWORD`;
`MIMIR_CHAT_PERSIST_PASSWORD=1` writes it through the debug store.
See [persistence.md](persistence.md) for atomic writes.

Renderer boundary: `src/services/chat.js`, `src/stores/chat.js`, and Chat
Activity/sidebar/settings components. Store owns per-room drafts, scroll state,
local search, active target, cached records, unread totals, and native event
reconciliation.

## Production service

Operations, deployment, backup/restore, protocol tests, and the Ergo upgrade
runbook are in [`deploy/chat/README.md`](../deploy/chat/README.md).
Agent launch and MCP injection are in [agent-setup.md](agent-setup.md).
