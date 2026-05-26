import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('../../audit.js', () => ({ logAudit: vi.fn() }))

import { createSearchWebTool } from './searchWeb'

const context = {
  sessionId: 's1',
  approvalMode: 'bypass',
  policy: {},
  userEmail: 'test@example.com',
}

describe('search_web tool', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('source: openalex', () => {
    it('searches and returns formatted results', async () => {
      const mockResponse = {
        results: [
          {
            title: 'Cost-effectiveness of interventions',
            authorships: [
              { author: { display_name: 'Smith A' } },
              { author: { display_name: 'Jones B' } },
            ],
            publication_year: 2024,
            doi: 'https://doi.org/10.1234/test',
            cited_by_count: 42,
            abstract_inverted_index: { Hello: [0], world: [1] },
            id: 'https://openalex.org/W123',
          },
        ],
      }
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const { search_web } = createSearchWebTool(context)
      const result = await search_web.execute({ source: 'openalex', query: 'cost effectiveness', limit: 5 })

      expect(result.count).toBe(1)
      expect(result.results[0].title).toBe('Cost-effectiveness of interventions')
      expect(result.results[0].authors).toBe('Smith A, Jones B')
      expect(result.results[0].year).toBe(2024)
      expect(result.results[0].doi).toBe('10.1234/test')
      expect(result.results[0].citation_count).toBe(42)
      expect(result.results[0].abstract).toBe('Hello world')

      const fetchUrl = vi.mocked(fetch).mock.calls[0][0]
      expect(fetchUrl).toContain('mailto=test@example.com')
      expect(fetchUrl).toContain('per_page=5')
    })

    it('adds et al. for >3 authors', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          results: [{
            title: 'Multi-author',
            authorships: [
              { author: { display_name: 'A' } },
              { author: { display_name: 'B' } },
              { author: { display_name: 'C' } },
              { author: { display_name: 'D' } },
            ],
            publication_year: 2023,
            doi: null,
            cited_by_count: 0,
            abstract_inverted_index: null,
            id: null,
          }],
        }),
      })

      const { search_web } = createSearchWebTool(context)
      const result = await search_web.execute({ source: 'openalex', query: 'test' })
      expect(result.results[0].authors).toBe('A, B, C et al.')
    })

    it('returns error on fetch failure', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 500 })

      const { search_web } = createSearchWebTool(context)
      const result = await search_web.execute({ source: 'openalex', query: 'test' })
      expect(result.error).toMatch(/OpenAlex search failed/)
    })

    it('returns error on network error', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'))

      const { search_web } = createSearchWebTool(context)
      const result = await search_web.execute({ source: 'openalex', query: 'test' })
      expect(result.error).toMatch(/Network error/)
    })
  })

  describe('source: crossref', () => {
    it('looks up DOI and returns CSL-JSON', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          message: {
            type: 'journal-article',
            title: ['Effectiveness study'],
            author: [{ family: 'Smith', given: 'John' }],
            DOI: '10.1234/test',
            URL: 'https://doi.org/10.1234/test',
            published: { 'date-parts': [[2024]] },
            'container-title': ['Journal of Testing'],
            volume: '12',
            issue: '3',
            page: '100-110',
            publisher: 'Test Publisher',
          },
        }),
      })

      const { search_web } = createSearchWebTool(context)
      const result = await search_web.execute({ source: 'crossref', query: '10.1234/test' })

      expect(result.source).toBe('crossref')
      expect(result.result.type).toBe('article-journal')
      expect(result.result.title).toBe('Effectiveness study')
      expect(result.result._key).toBe('smith2024')
      expect(result.result.DOI).toBe('10.1234/test')
      expect(result.result['container-title']).toBe('Journal of Testing')
    })

    it('strips doi.org URL prefix from query', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          message: {
            type: 'book',
            title: ['A Book'],
            author: [{ family: 'Doe', given: 'J' }],
            DOI: '10.5678/book',
            URL: 'https://doi.org/10.5678/book',
          },
        }),
      })

      const { search_web } = createSearchWebTool(context)
      await search_web.execute({ source: 'crossref', query: 'https://doi.org/10.5678/book' })

      const fetchUrl = vi.mocked(fetch).mock.calls[0][0]
      expect(fetchUrl).toContain('/works/10.5678%2Fbook')
      expect(fetchUrl).not.toContain('doi.org/10.5678')
    })

    it('returns error for failed lookup', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 404 })

      const { search_web } = createSearchWebTool(context)
      const result = await search_web.execute({ source: 'crossref', query: '10.9999/fake' })
      expect(result.error).toMatch(/CrossRef lookup failed/)
    })
  })

  describe('source: arxiv', () => {
    it('looks up arxiv ID and returns CSL-JSON', async () => {
      const xml = `<?xml version="1.0"?>
        <feed>
          <title>ArXiv Query</title>
          <entry>
            <title>A Neural Network Approach</title>
            <author><name>Jane Smith</name></author>
            <author><name>Bob Jones</name></author>
            <published>2024-01-15T00:00:00Z</published>
            <arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">10.1234/arxiv</arxiv:doi>
          </entry>
        </feed>`
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(xml),
      })

      const { search_web } = createSearchWebTool(context)
      const result = await search_web.execute({ source: 'arxiv', query: '2401.12345' })

      expect(result.source).toBe('arxiv')
      expect(result.result.title).toBe('A Neural Network Approach')
      expect(result.result.author).toHaveLength(2)
      expect(result.result.author[0]).toEqual({ family: 'Smith', given: 'Jane' })
      expect(result.result.DOI).toBe('10.1234/arxiv')
      expect(result.result.URL).toBe('https://arxiv.org/abs/2401.12345')
    })

    it('extracts arxiv ID from full URL', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<feed><title>Q</title><entry><title>T</title><published>2024</published></entry></feed>'),
      })

      const { search_web } = createSearchWebTool(context)
      await search_web.execute({ source: 'arxiv', query: 'https://arxiv.org/abs/2401.12345v2' })

      const fetchUrl = vi.mocked(fetch).mock.calls[0][0]
      expect(fetchUrl).toContain('id_list=2401.12345v2')
    })

    it('returns error on fetch failure', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Timeout'))

      const { search_web } = createSearchWebTool(context)
      const result = await search_web.execute({ source: 'arxiv', query: '2401.12345' })
      expect(result.error).toMatch(/arXiv lookup failed/)
    })
  })

  it('returns error for unknown source', async () => {
    const { search_web } = createSearchWebTool(context)
    const result = await search_web.execute({ source: 'invalid', query: 'test' })
    expect(result.error).toMatch(/Unknown source/)
  })
})
