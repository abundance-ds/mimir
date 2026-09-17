# Repository instructions

- Read [README.md](README.md).
- Consult [docs/_MAP.md](docs/_MAP.md) before editing.
- For any UI work, read [docs/design-system.md](docs/design-system.md).
- Check [docs/gotchas.md](docs/gotchas.md) (constraints) and
  [docs/issues.md](docs/issues.md) (known defects) before changing a subsystem.
- One owner per topic: feature detail lives in its owning doc, never
  duplicated; the README stays orientation and minimal setup.
- Follow ASD-STE100 in ALL user communication. Without exception.
- Never use `request_user_input_async` to ask the user a question. It does not
  wait for a reply. Ask in plain text and wait for the reply instead.
- If the user asks to create a release, follow `docs/building.md`.
