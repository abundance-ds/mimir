import { tool } from 'ai'
import { z } from 'zod'
import { withGate } from './gate'
import { crossrefTypeToCsl, reconstructAbstract } from './helpers'

export function createSearchWebTool(context) {
  const gateCtx = {
    sessionId: context.sessionId,
    policy: context.policy,
    onApprovalRequest: context.onApprovalRequest,
    approvalMode: context.approvalMode,
  }

  return {
    search_web: tool({
      description:
        'Search academic sources online. "openalex" = paper search, "crossref" = DOI metadata lookup, ' +
        '"arxiv" = arXiv metadata lookup. Returns metadata only — does not import.\n' +
        'Use edit("@library.json", ...) to import a result into the library. limit applies to openalex only (crossref/arxiv return one result).',
      inputSchema: z.object({
        source: z.enum(['openalex', 'crossref', 'arxiv']),
        query: z.string().min(1).max(500),
        limit: z.number().int().min(1).max(20).optional(),
      }),
      execute: withGate('search_web', async ({ source, query, limit = 5 }) => {

        if (source === 'openalex') {
          const mailto = context.userEmail || 'shoulders-editor@users.noreply'
          const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per_page=${limit}&mailto=${mailto}`
          try {
            const resp = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(15000) })
            if (!resp.ok) return { error: `OpenAlex search failed (${resp.status}).` }
            const data = await resp.json()
            const results = (data.results || []).map(work => {
              const authors = (work.authorships || [])
                .slice(0, 3)
                .map(a => a.author?.display_name || '')
                .filter(Boolean)
              const authorStr = authors.length > 0
                ? authors.join(', ') + (work.authorships?.length > 3 ? ' et al.' : '')
                : 'Unknown'
              const year = work.publication_year || null
              const doi = work.doi ? work.doi.replace('https://doi.org/', '') : null
              const abstractRaw = work.abstract_inverted_index
                ? reconstructAbstract(work.abstract_inverted_index)
                : null
              return {
                title: work.title || 'Untitled',
                authors: authorStr,
                year,
                doi,
                citation_count: work.cited_by_count || 0,
                abstract: abstractRaw ? abstractRaw.slice(0, 200) + (abstractRaw.length > 200 ? '...' : '') : null,
                openalex_id: work.id || null,
              }
            })
            return { query, count: results.length, results }
          } catch (e) {
            return { error: `OpenAlex fetch failed: ${e?.message || e}` }
          }
        }

        if (source === 'crossref') {
          let doi = query.replace(/^https?:\/\/doi\.org\//i, '').replace(/^doi:\s*/i, '').trim()
          if (!doi) return { error: 'No DOI provided.' }
          try {
            const resp = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
              headers: { 'Accept': 'application/json' },
              signal: AbortSignal.timeout(15000),
            })
            if (!resp.ok) return { error: `CrossRef lookup failed (${resp.status}). Check the DOI: ${doi}` }
            const data = await resp.json()
            const item = data?.message
            if (!item) return { error: 'CrossRef returned empty data.' }
            const authors = (item.author || []).map(a => ({ family: a.family || '', given: a.given || '' }))
            const year = item.published?.['date-parts']?.[0]?.[0]
              || item['published-print']?.['date-parts']?.[0]?.[0]
              || item['published-online']?.['date-parts']?.[0]?.[0]
              || null
            const firstAuthor = authors.length > 0 ? authors[0].family?.toLowerCase().replace(/\s+/g, '') : 'unknown'
            const key = `${firstAuthor}${year || ''}`
            const csl = {
              id: key,
              _key: key,
              type: crossrefTypeToCsl(item.type),
              title: Array.isArray(item.title) ? item.title[0] : (item.title || 'Untitled'),
              author: authors,
              DOI: item.DOI || doi,
              URL: item.URL || `https://doi.org/${doi}`,
            }
            if (year) csl.issued = { 'date-parts': [[year]] }
            if (item['container-title']?.length) csl['container-title'] = item['container-title'][0]
            if (item.volume) csl.volume = item.volume
            if (item.issue) csl.issue = item.issue
            if (item.page) csl.page = item.page
            if (item.publisher) csl.publisher = item.publisher
            if (item.abstract) csl.abstract = item.abstract.replace(/<[^>]*>/g, '')
            if (item.ISSN?.length) csl.ISSN = item.ISSN[0]
            if (item.ISBN?.length) csl.ISBN = item.ISBN[0]
            return { source: 'crossref', result: csl }
          } catch (e) {
            return { error: `CrossRef fetch failed: ${e?.message || e}` }
          }
        }

        if (source === 'arxiv') {
          let arxivId = query.trim()
          const urlMatch = arxivId.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}(?:v\d+)?)/i)
          if (urlMatch) arxivId = urlMatch[1]
          try {
            const resp = await fetch(`https://export.arxiv.org/api/query?id_list=${arxivId}&max_results=1`, { signal: AbortSignal.timeout(15000) })
            const xml = await resp.text()
            const titleMatch = xml.match(/<title[^>]*>([^<]+)<\/title>/g)
            const title = titleMatch && titleMatch.length > 1
              ? titleMatch[1].replace(/<\/?title[^>]*>/g, '').trim()
              : `arXiv:${arxivId}`
            const authorMatches = [...xml.matchAll(/<author>\s*<name>([^<]+)<\/name>/g)]
            const authors = authorMatches.map(m => {
              const parts = m[1].trim().split(/\s+/)
              return { family: parts[parts.length - 1], given: parts.slice(0, -1).join(' ') }
            })
            const publishedMatch = xml.match(/<published>(\d{4})/i)
            const year = publishedMatch ? parseInt(publishedMatch[1]) : null
            const doiMatch = xml.match(/<arxiv:doi[^>]*>([^<]+)<\/arxiv:doi>/i)
            const csl = {
              id: arxivId,
              _key: authors.length > 0
                ? `${authors[0].family?.toLowerCase() || 'unknown'}${year || ''}`.replace(/\s+/g, '')
                : `arxiv${arxivId.replace('.', '')}`,
              type: 'article',
              title,
              author: authors,
              URL: `https://arxiv.org/abs/${arxivId}`,
            }
            if (doiMatch) csl.DOI = doiMatch[1].trim()
            if (year) csl.issued = { 'date-parts': [[year]] }
            return { source: 'arxiv', result: csl }
          } catch (e) {
            return { error: `arXiv lookup failed: ${e?.message || e}` }
          }
        }

        return { error: `Unknown source: ${source}` }
      }, gateCtx),
    }),
  }
}
