export const EDITOR_TRAFFIC_LIGHT_POSITION = { x: 14, y: 14 }
export const PANEL_TRAFFIC_LIGHT_POSITION = { x: 14, y: 14 }
export const EDITOR_WINDOW_BACKGROUND = '#ebe9e3'
export const PANEL_WINDOW_BACKGROUND = '#f4eee0'

export function macWindowChromeOptions({
  trafficLightPosition = EDITOR_TRAFFIC_LIGHT_POSITION,
  backgroundColor = EDITOR_WINDOW_BACKGROUND,
} = {}) {
  return {
    backgroundColor,
    decorations: true,
    titleBarStyle: 'overlay',
    hiddenTitle: true,
    trafficLightPosition,
  }
}

export const editorWindowChromeOptions = macWindowChromeOptions()
export const panelWindowChromeOptions = macWindowChromeOptions({
  trafficLightPosition: PANEL_TRAFFIC_LIGHT_POSITION,
  backgroundColor: PANEL_WINDOW_BACKGROUND,
})
