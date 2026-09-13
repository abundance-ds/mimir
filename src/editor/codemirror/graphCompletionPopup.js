import { ViewPlugin, repositionTooltips, tooltips } from '@codemirror/view'

const PREFERRED_WIDTH = 320
const MAX_HEIGHT = 248
const EDGE_INSET = 8

// Rectangles are CSS viewport pixels, as returned by getBoundingClientRect.
// Native zoom and visualViewport already use these units; do not apply DPR/scale.
export function graphCompletionBounds({ viewport, pane = viewport }) {
  const left = Math.min(viewport.right, Math.max(viewport.left, pane.left))
  const right = Math.max(left, Math.min(viewport.right, pane.right))
  const top = Math.min(viewport.bottom, Math.max(viewport.top, pane.top))
  const bottom = Math.max(top, Math.min(viewport.bottom, pane.bottom))
  const insetX = Math.min(EDGE_INSET, (right - left) / 2)
  const insetY = Math.min(EDGE_INSET, (bottom - top) / 2)
  const space = { left: left + insetX, right: right - insetX, top: top + insetY, bottom: bottom - insetY }
  return {
    space,
    width: Math.min(PREFERRED_WIDTH, space.right - space.left),
    maxHeight: Math.min(MAX_HEIGHT, space.bottom - space.top),
  }
}

function measureBounds(view) {
  const document = view.dom.ownerDocument
  const window = document.defaultView
  const visual = window.visualViewport
  const left = visual?.offsetLeft || 0
  const top = visual?.offsetTop || 0
  const width = visual?.width || document.documentElement.clientWidth || window.innerWidth
  const height = visual?.height || document.documentElement.clientHeight || window.innerHeight
  const viewport = { left, top, right: left + width, bottom: top + height }
  const pane = (view.dom.closest('[data-graph-inspector], [role="dialog"], [data-pane-content]') || view.dom).getBoundingClientRect()
  return graphCompletionBounds({ viewport, pane: pane.width > 0 && pane.height > 0 ? pane : viewport })
}

export function graphCompletionPopup() {
  // The zero-sized host cannot intercept pane input. CodeMirror preserves its
  // theme classes in the child container and positions each tooltip itself.
  const portal = document.createElement('div')
  portal.dataset.graphCompletionPortal = ''
  portal.dataset.modalPortal = ''
  Object.assign(portal.style, { position: 'fixed', left: '0', top: '0', width: '0', height: '0', zIndex: '500' })
  const geometry = ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view
      this.width = null
      this.maxHeight = null
      this.measure = {
        read: () => measureBounds(view),
        write: bounds => {
          if (bounds.width === this.width && bounds.maxHeight === this.maxHeight) return
          this.width = bounds.width
          this.maxHeight = bounds.maxHeight
          portal.style.setProperty('--graph-completion-width', `${bounds.width}px`)
          portal.style.setProperty('--graph-completion-max-height', `${bounds.maxHeight}px`)
          repositionTooltips(view)
        },
      }
      view.dom.ownerDocument.body.appendChild(portal)
      this.schedule = () => view.requestMeasure(this.measure)
      this.window = view.dom.ownerDocument.defaultView
      this.window.addEventListener('resize', this.schedule)
      this.resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(this.schedule) : null
      this.resizeObserver?.observe(view.dom.closest('[data-graph-inspector], [role="dialog"], [data-pane-content]') || view.dom)
      this.visualViewport = this.window.visualViewport
      this.visualViewport?.addEventListener('resize', this.schedule)
      this.visualViewport?.addEventListener('scroll', this.schedule)
      this.schedule()
    }
    update(update) {
      if (update.geometryChanged || update.viewportChanged) this.schedule()
    }
    destroy() {
      this.window.removeEventListener('resize', this.schedule)
      this.resizeObserver?.disconnect()
      this.visualViewport?.removeEventListener('resize', this.schedule)
      this.visualViewport?.removeEventListener('scroll', this.schedule)
      portal.remove()
    }
  })
  return [
    geometry,
    tooltips({ parent: portal, position: 'fixed', tooltipSpace: view => measureBounds(view).space }),
  ]
}

export function graphCompletionMetadata(completion) {
  const row = document.createElement('span')
  row.className = 'cm-graph-completion-meta'
  const kind = row.appendChild(document.createElement('span'))
  kind.className = 'cm-graph-completion-kind'
  kind.textContent = completion.graphKind || ''
  const scope = row.appendChild(document.createElement('span'))
  scope.className = 'cm-graph-completion-scope'
  scope.textContent = completion.graphScope || ''
  return row
}
