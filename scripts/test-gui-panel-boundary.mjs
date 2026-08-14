import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const boundary = readFileSync(
  new URL('../src/renderer/src/components/GuiPanelErrorBoundary.tsx', import.meta.url),
  'utf8'
)
const board = readFileSync(new URL('../src/renderer/src/components/Board.tsx', import.meta.url), 'utf8')
const panes = readFileSync(
  new URL('../src/renderer/src/components/PanesView.tsx', import.meta.url),
  'utf8'
)
const seats = readFileSync(
  new URL('../src/renderer/src/components/SeatDeck.tsx', import.meta.url),
  'utf8'
)
const universe = readFileSync(
  new URL('../src/renderer/src/screens/Universe.tsx', import.meta.url),
  'utf8'
)

test('falha de painel é contida, recuperável e não revela a exceção', () => {
  assert.match(boundary, /getDerivedStateFromError/)
  assert.match(boundary, /componentDidCatch/)
  assert.match(boundary, /role="alert"/)
  assert.match(boundary, /tentar de novo/)
  assert.doesNotMatch(boundary, /error\.message|info\.componentStack/)
})

test('painéis do board e do canvas ficam dentro do limite isolado', () => {
  assert.ok((board.match(/<GuiPanelErrorBoundary/g) ?? []).length >= 7)
  assert.ok((panes.match(/<GuiPanelErrorBoundary/g) ?? []).length >= 1)
  assert.match(board, /<GuiPanelErrorBoundary[\s\S]*<GuiPane/)
  assert.match(board, /<GuiPanelErrorBoundary[\s\S]*<TerminalPane/)
  assert.match(board, /paneId=\{`board-general:\$\{projectId\}`\}[\s\S]*<ProjectGeneral/)
  assert.match(board, /paneId=\{`mission-delivery:\$\{selMission\.id\}`\}[\s\S]*<MissionDeliveryRail/)
  assert.match(board, /paneId=\{`mission-column:\$\{projectId\}`\}[\s\S]*<MissionColumn/)
  assert.match(panes, /<GuiPanelErrorBoundary[\s\S]*<GuiPane/)
  assert.match(panes, /<GuiPanelErrorBoundary[\s\S]*<TerminalPane/)
  assert.match(seats, /<GuiPanelErrorBoundary[\s\S]*<TerminalPane/)
  assert.ok((universe.match(/<GuiPanelErrorBoundary/g) ?? []).length >= 4)
})
