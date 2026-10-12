// The only hooks module of loopkeeper. Each concern lives in its own file and is wired here with `on`.
// The order below is the order of the bands above the prompt and of the lines /lk status prints.

import type { On } from 'claude-code'

import { wireDecisions } from './decisions.ts'
import { wireFiles } from './files.ts'
import { wireGates } from './gates.ts'
import { wireReview } from './review.ts'
import { wireRouting } from './routing.ts'
import { wireStage } from './stage.ts'

export function register(on: On): void {
  wireStage(on)
  wireGates(on)
  wireFiles(on)
  wireRouting(on)
  wireReview(on)
  wireDecisions(on)
}
