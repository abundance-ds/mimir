# Chats

One stable Chats Activity owns channels and direct messages. Selecting a room
changes chat state without creating an Activity. Disabling Chats disconnects
transport and removes UI/tools but keeps credentials and cached history.

## Product and agents

- The Sidebar shows room presence and unread state. Each room retains its draft
  and scroll position.
- Offline history and search remain available; sending waits for connection.
- Attachments support picker, drop, and paste, then verify size and SHA-256
  before native open.
- Notifications are opt-in and limited to DMs and direct mentions. Muting
  suppresses alerts, not unread state.
- Starting an agent creates and links the Activity before spawn. The room prompt
  is editable PTY input and is not submitted automatically.
- Public tools are `chat_rooms`, `chat_read`, `chat_search`, `chat_send`, and
  `chat_download`. A linked Activity defaults to its originating room.

## Authority

`src-tauri/src/chat/` owns IRCv3/Ergo transport, SASL, reconnect, history,
presence, validation, file transfer, SQLite cache, and tools.
`~/.mimir/chat.sqlite3` is the offline/read-state authority. Configuration is in
`~/.mimir/chat.json`; credentials use Keychain in macOS release builds.

The renderer chat service/store own current room, drafts, scroll, local search,
unread projections, and UI event reconciliation. Server deployment, backup,
and protocol operation are in `deploy/chat/README.md`.
