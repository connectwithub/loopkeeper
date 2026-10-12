// panes.ts: the loopkeeper panes the hub and every pane's nav row switch between, in wiring order.
//
// Pure data, so every concern file imports the one table (`$` never crosses an import; a table does).
// Digit hotkeys never clash with the panes' own letter hotkeys.

export const HUB_ID = 'loopkeeper-hub'

/** Rows the hub opens with, so the inline hub is not a third of the screen. */
export const HUB_ROWS = 22

export const PANES = [
  { key: 'hub', hotkey: '0', label: 'Hub', id: HUB_ID, title: 'loopkeeper' },
  { key: 'stage', hotkey: '1', label: 'Stage', id: 'loopkeeper-stage', title: 'Stage' },
  { key: 'gates', hotkey: '2', label: 'Gates', id: 'loopkeeper-gates', title: 'Gates' },
  { key: 'files', hotkey: '3', label: 'Files', id: 'files', title: 'Files' },
  { key: 'routes', hotkey: '4', label: 'Routes', id: 'loopkeeper-routes', title: 'Routing' },
  { key: 'reviews', hotkey: '5', label: 'Reviews', id: 'loopkeeper-review', title: 'Review loops' },
  { key: 'decisions', hotkey: '6', label: 'Decisions', id: 'loopkeeper-decisions', title: 'Decisions' },
] as const

export type PaneKey = (typeof PANES)[number]['key']
