# Chats

One stable Chats Activity owns channels and direct messages. Selecting a room
changes chat state without creating an Activity. Disabling Chats disconnects
transport and removes UI/tools but keeps credentials and cached history.

## Product and agents

- Chats opens as one unique main tab. Each room retains its draft and scroll.
- Offline history and search remain available. Sending while disconnected
  errors immediately; it does not queue.
- Attachments verify size and SHA-256 before native open.
- Notifications are opt-in, limited to DMs and direct mentions. Muting
  suppresses alerts, not unread state.
- Starting an agent creates and links the Activity before spawn. The room prompt
  is editable PTY input and is not submitted automatically.
- Public tools are `chat_rooms`, `chat_read`, `chat_search`, `chat_send`, and
  `chat_download`. Tool target resolution order: explicit `target` parameter,
  then linked room from Activity, then the user's active UI room. An agent
  without a link and without an explicit target sends to whatever room is open.
- Agent messages use RELAYMSG when OPER is granted; otherwise fall back to a
  visible `[label]` prefix in the message body.

## Authority

`src-tauri/src/chat/` owns IRCv3/Ergo transport, SASL, reconnect, history,
presence, validation, file transfer, SQLite cache, and tools.
`~/.mimir/chat.sqlite3` is the offline/read-state authority. Configuration is in
`~/.mimir/chat.json`; credentials use Keychain in macOS release builds.

The renderer chat service/store own current room, drafts, scroll, local search,
unread projections, and UI event reconciliation. Server deployment, backup,
and protocol operation are in `deploy/chat/README.md`.
