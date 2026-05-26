/**
 * One-click compliance report DOCX generator.
 *
 * Produces a structured compliance report from audit data using the `docx`
 * npm package directly (not the markdown-based exportDocx pipeline).
 * Returns a Blob — the caller handles saving via Tauri dialog.
 */

import { queryAudit, queryAuditSummary, groupIntoEpisodes } from '../audit.js'
import { useSettingsStore } from '../../stores/settings.js'

// Lazy-loaded docx symbols — same pattern as docx.js to keep the 350KB
// package out of the initial bundle.
let Document, Packer, Paragraph, TextRun,
  Table, TableRow, TableCell,
  WidthType, AlignmentType, HeadingLevel, BorderStyle

async function ensureDocx() {
  if (Document) return
  const mod = await import('docx')
  ;({
    Document, Packer, Paragraph, TextRun,
    Table, TableRow, TableCell,
    WidthType, AlignmentType, HeadingLevel, BorderStyle,
  } = mod)
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function generateComplianceReport(projectId, projectName) {
  await ensureDocx()

  const settings = useSettingsStore()
  const identity = settings.auditIdentity || 'Analyst'

  // Query all audit data for this project
  const [events, summary] = await Promise.all([
    queryAudit({ projectId, limit: 10000 }),
    queryAuditSummary({ projectId }),
  ])

  const episodes = groupIntoEpisodes(events)

  // Compute metrics
  const toolEvents = events.filter(e => e.event_type === 'tool.execute')
  const approvedCount = toolEvents.filter(e => {
    try { return JSON.parse(e.payload || '{}').approvalDecision === 'user_approved' }
    catch { return false }
  }).length
  const reviewCoverage = toolEvents.length
    ? Math.round((approvedCount / toolEvents.length) * 100)
    : 100

  const aiModels = [...new Set(
    events.filter(e => e.actor?.startsWith('ai:')).map(e => e.actor.replace('ai:', ''))
  )]

  const aiRequestCount = events.filter(e => e.event_type === 'ai.request').length
  const toolCallCount = toolEvents.length
  const exportCount = events.filter(e => e.event_type === 'export.run').length

  const dateRange = events.length
    ? `${formatDate(events[events.length - 1].timestamp)} – ${formatDate(events[0].timestamp)}`
    : 'No activity'

  const now = new Date()
  const generatedAt = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

  // Build document
  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: 'Calibri', size: 22 },
        },
      },
    },
    sections: [{
      properties: {
        page: {
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
        },
      },
      children: [
        // ── Cover ──
        heading('Compliance Report', HeadingLevel.HEADING_1),
        spacer(),
        para(`Project: ${projectName}`),
        para(`Period: ${dateRange}`),
        para(`Generated: ${generatedAt}`),
        para(`Analyst: ${identity}`),
        spacer(),
        separator(),

        // ── Summary ──
        heading('Summary', HeadingLevel.HEADING_2),
        spacer(),
        summaryTable([
          ['Total AI interactions', String(aiRequestCount)],
          ['Tool calls', String(toolCallCount)],
          ['Human review coverage', `${reviewCoverage}%`],
          ['Models used', aiModels.length ? aiModels.join(', ') : 'None'],
          ['Exports', String(exportCount)],
          ['Total logged events', String(summary.total_events)],
        ]),
        spacer(),

        // ── AI Models ──
        heading('AI Models & Configuration', HeadingLevel.HEADING_2),
        spacer(),
        ...(aiModels.length
          ? aiModels.map(m => bulletPoint(m))
          : [para('No AI models were used in this project.')]),
        spacer(),

        // ── Activity timeline (condensed) ──
        heading('Activity Timeline', HeadingLevel.HEADING_2),
        spacer(),
        ...episodes.slice(0, 200).flatMap(ep => [
          new Paragraph({
            children: [
              new TextRun({ text: formatDateTime(ep.timestamp), font: 'Courier New', size: 18, color: '888888' }),
              new TextRun({ text: '  ' }),
              new TextRun({ text: ep.summary, size: 20 }),
              ...(ep.events.length > 1
                ? [new TextRun({ text: ` (${ep.events.length} events)`, size: 18, color: '888888' })]
                : []),
            ],
            spacing: { after: 60 },
          }),
        ]),
        spacer(),

        // ── Attestation ──
        separator(),
        heading('Attestation', HeadingLevel.HEADING_2),
        spacer(),
        ...(reviewCoverage === 100
          ? [para(`All AI-assisted operations in this project were reviewed and approved by ${identity}.`)]
          : [
              para(`${reviewCoverage}% of AI-assisted operations in this project were reviewed and approved by ${identity}.`),
              para('Some operations were auto-approved based on the configured approval policy.'),
            ]
        ),
        spacer(),
        para(`Signed: ${identity}`),
        para(`Date: ${generatedAt}`),
      ],
    }],
  })

  return Packer.toBlob(doc)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function heading(text, level) {
  return new Paragraph({ text, heading: level, spacing: { after: 120 } })
}

function para(text) {
  return new Paragraph({ children: [new TextRun({ text, size: 22 })], spacing: { after: 80 } })
}

function bulletPoint(text) {
  return new Paragraph({
    children: [new TextRun({ text, size: 22 })],
    bullet: { level: 0 },
    spacing: { after: 40 },
  })
}

function spacer() {
  return new Paragraph({ text: '', spacing: { after: 200 } })
}

function separator() {
  return new Paragraph({
    border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' } },
    spacing: { after: 200 },
  })
}

function summaryTable(rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(([label, value]) =>
      new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: label, size: 20 })] })],
            width: { size: 60, type: WidthType.PERCENTAGE },
            borders: cellBorders(),
          }),
          new TableCell({
            children: [new Paragraph({
              children: [new TextRun({ text: value, size: 20, bold: true, font: 'Courier New' })],
              alignment: AlignmentType.RIGHT,
            })],
            width: { size: 40, type: WidthType.PERCENTAGE },
            borders: cellBorders(),
          }),
        ],
      })
    ),
  })
}

function cellBorders() {
  const border = { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' }
  return { top: border, bottom: border, left: border, right: border }
}

function formatDate(iso) {
  if (!iso) return '--'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatDateTime(iso) {
  if (!iso) return '--'
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}
