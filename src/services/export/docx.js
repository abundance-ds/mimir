/**
 * Markdown -> DOCX export via `marked` lexer + `docx` npm package.
 *
 * Ported from hugin-munin/src/services/docxExport.js.
 * PDF export lives in Rust (typst_export.rs). DOCX lives in JS because the
 * `docx` npm package vastly outmatches any Rust DOCX crate.
 */

import { Marked } from 'marked'
import { stripCommentTags as stripCommentTagsFromExport } from '../comments/parser.js'

// Lazy-loaded docx symbols -- resolved on first export call to keep the 350KB
// package out of the initial bundle.
let Document, Packer, Paragraph, TextRun,
  HeadingLevel, AlignmentType, BorderStyle, ShadingType, WidthType,
  Table, TableRow, TableCell,
  ExternalHyperlink, FootnoteReferenceRun,
  LevelFormat,
  convertInchesToTwip

async function ensureDocx() {
  if (Document) return
  const mod = await import('docx')
  ;({
    Document, Packer, Paragraph, TextRun,
    HeadingLevel, AlignmentType, BorderStyle, ShadingType, WidthType,
    Table, TableRow, TableCell,
    ExternalHyperlink, FootnoteReferenceRun,
    LevelFormat,
    convertInchesToTwip,
  } = mod)
}

// ---------------------------------------------------------------------------
// Marked instance
// ---------------------------------------------------------------------------

const parser = new Marked()

// ---------------------------------------------------------------------------
// Settings mappings
// ---------------------------------------------------------------------------

const PAGE_SIZES = {
  'a4': { width: 11906, height: 16838 },
  'us-letter': { width: 12240, height: 15840 },
  'a5': { width: 8391, height: 11906 },
}

function marginTwip(preset) {
  const map = { narrow: 0.5, normal: 1, wide: 1.5 }
  return convertInchesToTwip(map[preset] ?? 1)
}

const HEADING_MAP = {
  1: 'HEADING_1',
  2: 'HEADING_2',
  3: 'HEADING_3',
  4: 'HEADING_4',
  5: 'HEADING_5',
  6: 'HEADING_6',
}

// ---------------------------------------------------------------------------
// Pre-processing helpers
// ---------------------------------------------------------------------------

function stripFrontmatter(md) {
  if (!md.startsWith('---')) return md
  const end = md.indexOf('\n---', 3)
  if (end < 0) return md
  return md.substring(end + 4)
}

/** Extract [^label]: content definitions and remove them from the markdown. */
function extractFootnotes(md) {
  const defs = {}
  const cleaned = md.replace(
    /^\[\^([^\]]+)\]:\s*(.+(?:\n(?!\[\^|\n|\S).*)*)/gm,
    (_, label, content) => {
      defs[label] = content.trim()
      return ''
    },
  )
  return { cleaned, defs }
}

// ---------------------------------------------------------------------------
// Footnote inline pattern
// ---------------------------------------------------------------------------

const FOOTNOTE_RE = /\[\^([^\]]+)\]/
const INLINE_SPLIT_RE = /(\[\^[^\]]+\])/g

function processTextWithFootnotes(text, ctx, formatting) {
  if (!text) return []
  const runs = []
  const parts = text.split(INLINE_SPLIT_RE)

  for (const part of parts) {
    if (!part) continue

    const fnMatch = part.match(FOOTNOTE_RE)
    if (fnMatch && part === fnMatch[0]) {
      const label = fnMatch[1]
      const fnId = ctx.footnoteIds[label]
      if (fnId !== undefined) {
        runs.push(new FootnoteReferenceRun(fnId))
        continue
      }
    }

    if (part) runs.push(new TextRun({ text: part, ...formatting }))
  }

  return runs
}

// ---------------------------------------------------------------------------
// Inline token walker
// ---------------------------------------------------------------------------

function convertInlineTokens(tokens, ctx, formatting = {}) {
  if (!tokens) return []
  const runs = []

  for (const token of tokens) {
    switch (token.type) {
      case 'text':
        runs.push(...processTextWithFootnotes(token.text ?? token.raw, ctx, formatting))
        break
      case 'strong':
        runs.push(...convertInlineTokens(token.tokens, ctx, { ...formatting, bold: true }))
        break
      case 'em':
        runs.push(...convertInlineTokens(token.tokens, ctx, { ...formatting, italics: true }))
        break
      case 'codespan':
        runs.push(new TextRun({
          text: token.text,
          font: { name: 'Consolas' },
          size: 20,
          shading: { type: ShadingType.CLEAR, fill: 'F0F0F0' },
          ...formatting,
        }))
        break
      case 'link':
        runs.push(new ExternalHyperlink({
          link: token.href,
          children: convertInlineTokens(token.tokens, ctx, formatting),
        }))
        break
      case 'image':
        // Show alt text as placeholder (no binary image loading)
        runs.push(new TextRun({ text: `[${token.text || 'image'}]`, ...formatting, italics: true }))
        break
      case 'del':
        runs.push(...convertInlineTokens(token.tokens, ctx, { ...formatting, strike: true }))
        break
      case 'br':
        runs.push(new TextRun({ break: 1 }))
        break
      case 'escape':
        runs.push(new TextRun({ text: token.text, ...formatting }))
        break
      default:
        if (token.raw) runs.push(new TextRun({ text: token.raw, ...formatting }))
        break
    }
  }
  return runs
}

// ---------------------------------------------------------------------------
// Block token walkers
// ---------------------------------------------------------------------------

function convertCodeBlock(token) {
  const lines = token.text.split('\n')
  return lines.map((line, i) => new Paragraph({
    children: [new TextRun({
      text: line || ' ',
      font: { name: 'Consolas' },
      size: 20,
    })],
    shading: { type: ShadingType.CLEAR, fill: 'F5F5F5' },
    spacing: { before: i === 0 ? 120 : 0, after: i === lines.length - 1 ? 120 : 0 },
    indent: { left: convertInchesToTwip(0.25) },
  }))
}

function convertBlockquote(token, ctx) {
  const children = convertBlockTokens(token.tokens, ctx)
  return children.map(child => {
    if (child instanceof Paragraph) {
      return new Paragraph({
        ...child,
        indent: { left: convertInchesToTwip(0.5) },
        border: { left: { style: BorderStyle.SINGLE, size: 3, color: 'CCCCCC', space: 8 } },
      })
    }
    return child
  })
}

function convertList(token, ctx, level) {
  const children = []
  for (const item of token.items) {
    const inlineTokens = []
    const nested = []

    for (const t of item.tokens) {
      if (t.type === 'text' && t.tokens) {
        inlineTokens.push(...t.tokens)
      } else if (t.type === 'paragraph') {
        if (inlineTokens.length === 0) {
          inlineTokens.push(...(t.tokens || []))
        } else {
          nested.push(t)
        }
      } else if (t.type === 'list') {
        nested.push(t)
      } else if (t.type === 'space') {
        // skip
      } else {
        nested.push(t)
      }
    }

    children.push(new Paragraph({
      children: convertInlineTokens(inlineTokens, ctx),
      ...(token.ordered
        ? { numbering: { reference: 'ordered-list', level } }
        : { bullet: { level } }),
    }))

    for (const block of nested) {
      if (block.type === 'list') {
        children.push(...convertList(block, ctx, level + 1))
      } else if (block.type === 'paragraph') {
        children.push(new Paragraph({
          children: convertInlineTokens(block.tokens, ctx),
          indent: { left: convertInchesToTwip(0.25 * (level + 1)) },
        }))
      }
    }
  }
  return children
}

function convertTable(token, ctx) {
  const borderStyle = {
    style: BorderStyle.SINGLE,
    size: 1,
    color: 'CCCCCC',
  }

  const rows = []

  if (token.header?.length) {
    rows.push(new TableRow({
      tableHeader: true,
      children: token.header.map(cell => new TableCell({
        children: [new Paragraph({
          children: convertInlineTokens(cell.tokens, ctx, { bold: true }),
        })],
        shading: { type: ShadingType.CLEAR, fill: 'F5F5F5' },
      })),
    }))
  }

  for (const row of (token.rows || [])) {
    rows.push(new TableRow({
      children: row.map(cell => new TableCell({
        children: [new Paragraph({
          children: convertInlineTokens(cell.tokens, ctx),
        })],
      })),
    }))
  }

  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: borderStyle,
      bottom: borderStyle,
      left: borderStyle,
      right: borderStyle,
      insideHorizontal: borderStyle,
      insideVertical: borderStyle,
    },
  })
}

function convertBlockTokens(tokens, ctx) {
  const children = []
  for (const token of tokens) {
    switch (token.type) {
      case 'heading':
        children.push(new Paragraph({
          heading: HeadingLevel[HEADING_MAP[token.depth]] || HeadingLevel.HEADING_3,
          children: convertInlineTokens(token.tokens, ctx),
        }))
        break
      case 'paragraph':
        children.push(new Paragraph({
          children: convertInlineTokens(token.tokens, ctx),
          spacing: { after: 120 },
        }))
        break
      case 'list':
        children.push(...convertList(token, ctx, 0))
        break
      case 'table':
        children.push(convertTable(token, ctx))
        break
      case 'code':
        children.push(...convertCodeBlock(token))
        break
      case 'blockquote':
        children.push(...convertBlockquote(token, ctx))
        break
      case 'hr':
        children.push(new Paragraph({
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'AAAAAA' } },
          spacing: { before: 200, after: 200 },
        }))
        break
      case 'html':
        if (token.text) {
          const stripped = token.text.replace(/<[^>]+>/g, '').trim()
          if (stripped) {
            children.push(new Paragraph({
              children: [new TextRun(stripped)],
              spacing: { after: 120 },
            }))
          }
        }
        break
      case 'space':
        break
    }
  }
  return children
}

// ---------------------------------------------------------------------------
// Main export function
// ---------------------------------------------------------------------------

/**
 * Convert markdown content to a DOCX blob.
 *
 * @param {string} markdown - raw markdown (may include YAML frontmatter)
 * @param {object} options
 * @param {string} options.font - font family name (default: 'Calibri')
 * @param {number} options.fontSize - font size in pt (default: 11)
 * @param {string} options.pageSize - 'a4', 'us-letter', 'a5' (default: 'a4')
 * @param {string} options.margins - 'narrow', 'normal', 'wide' (default: 'normal')
 * @param {string} options.title - document title metadata
 * @returns {Promise<{ blob: Blob, fileName: string }>}
 */
export async function exportDocx(markdown, options = {}) {
  await ensureDocx()

  const {
    font = 'Calibri',
    fontSize = 11,
    pageSize = 'a4',
    margins = 'normal',
    title = 'Document',
  } = options

  const fontSizeHp = fontSize * 2 // half-points for OOXML
  const pageDims = PAGE_SIZES[pageSize] || PAGE_SIZES.a4
  const marginTwips = marginTwip(margins)

  // 1. Strip frontmatter and inline comment tags
  const stripped = stripFrontmatter(stripCommentTagsFromExport(markdown))

  // 2. Extract footnotes
  const { cleaned, defs: footnoteDefs } = extractFootnotes(stripped)

  // 3. Assign footnote IDs
  const footnoteIds = {}
  let fnCounter = 1
  for (const label of Object.keys(footnoteDefs)) {
    footnoteIds[label] = fnCounter++
  }

  // 4. Parse with marked
  const tokens = parser.lexer(cleaned)

  // 5. Build context
  const ctx = { footnoteIds }

  // 6. Convert block tokens
  const children = convertBlockTokens(tokens, ctx)

  // 7. Build footnote definitions for docx
  const footnotes = {}
  for (const [label, content] of Object.entries(footnoteDefs)) {
    const id = footnoteIds[label]
    footnotes[id] = {
      children: [new Paragraph({ children: [new TextRun({ text: content, size: 20 })] })],
    }
  }

  // 8. Numbering config for ordered lists
  const numberingConfig = [{
    reference: 'ordered-list',
    levels: [
      { level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START, style: { paragraph: { indent: { left: convertInchesToTwip(0.5), hanging: convertInchesToTwip(0.25) } } } },
      { level: 1, format: LevelFormat.LOWER_LETTER, text: '%2.', alignment: AlignmentType.START, style: { paragraph: { indent: { left: convertInchesToTwip(1), hanging: convertInchesToTwip(0.25) } } } },
      { level: 2, format: LevelFormat.LOWER_ROMAN, text: '%3.', alignment: AlignmentType.START, style: { paragraph: { indent: { left: convertInchesToTwip(1.5), hanging: convertInchesToTwip(0.25) } } } },
    ],
  }]

  // 9. Assemble document
  const h1Size = Math.round(fontSizeHp * 1.45)
  const h2Size = Math.round(fontSizeHp * 1.27)
  const h3Size = Math.round(fontSizeHp * 1.09)

  const doc = new Document({
    creator: 'Shoulders',
    title,
    styles: {
      default: {
        document: {
          run: { font, size: fontSizeHp },
        },
        heading1: { run: { size: h1Size, bold: true, font }, paragraph: { spacing: { before: 240, after: 120 } } },
        heading2: { run: { size: h2Size, bold: true, font }, paragraph: { spacing: { before: 200, after: 100 } } },
        heading3: { run: { size: h3Size, bold: true, font }, paragraph: { spacing: { before: 160, after: 80 } } },
      },
    },
    numbering: { config: numberingConfig },
    footnotes,
    sections: [{
      properties: {
        page: {
          size: pageDims,
          margin: { top: marginTwips, right: marginTwips, bottom: marginTwips, left: marginTwips },
        },
      },
      children,
    }],
  })

  const blob = await Packer.toBlob(doc)
  return { blob, fileName: `${title}.docx` }
}
