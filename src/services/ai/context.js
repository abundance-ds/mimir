export function buildPrefixSuffix(
  state,
  pos,
  beforeLimit = 5000,
  afterLimit = 1000,
) {
  return {
    before: smartSliceStart(
      state.sliceDoc(Math.max(0, pos - beforeLimit), pos),
      beforeLimit,
    ),
    after: smartSliceEnd(
      state.sliceDoc(pos, Math.min(state.doc.length, pos + afterLimit)),
      afterLimit,
    ),
  };
}

export function documentIdFromPath(path) {
  if (!path) return null;
  return path.replace(/^\/+/, "").replace(/[^a-zA-Z0-9._/-]+/g, "-");
}

export function escapePromptXml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function smartSliceStart(text, maxLen) {
  if (text.length <= maxLen) return text;
  const trimmed = text.slice(-maxLen);
  const firstSpace = trimmed.indexOf(" ");
  return firstSpace > 0 && firstSpace < 120
    ? trimmed.slice(firstSpace + 1)
    : trimmed;
}

function smartSliceEnd(text, maxLen) {
  if (text.length <= maxLen) return text;
  const trimmed = text.slice(0, maxLen);
  const lastSpace = trimmed.lastIndexOf(" ");
  return lastSpace > maxLen - 120 ? trimmed.slice(0, lastSpace) : trimmed;
}
