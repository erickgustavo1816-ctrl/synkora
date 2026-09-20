import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { buildSync } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SCOPE_NOTE, guiContextPanelPresentation } from '../src/renderer/src/guiContextPanel.ts'
import { guiContextPopoverLayout } from '../src/renderer/src/guiContextPopover.ts'
import {
  guiExpensiveSwitchNote,
  guiHeavyConversationTip,
  guiMeterTone,
  guiOdometerPresentation,
  guiSeatQuotaPresentation
} from '../src/renderer/src/guiCostSignals.ts'
import * as costSignals from '../src/renderer/src/guiCostSignals.ts'

const readWorkspaceFile = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('usage weight explicitly remains an estimate and never promises the subscription quota formula', () => {
  const meter = guiOdometerPresentation(139, 3_596_250, 192_000)
  assert.match(meter.valueLabel, /estimativa/u)
  assert.match(meter.hint, /não.*cota|não.*fórmula/u)
  assert.match(SCOPE_NOTE, /assinatura/u)
})

test('usage presentation separates a measured round, conversation history and missing parcels', () => {
  const usage = { apiCalls: 2, inputTokens: 150, cacheWriteTokens: null, cacheReadTokens: 2_000, outputTokens: 30 }
  const view = costSignals.guiUsageMetersPresentation({
    conversation: { ...usage, apiCalls: 42, inputTokens: 10_000 },
    round: { id: 'synthetic-round', usage }
  })
  assert.equal(view.conversation.label, 'total da conversa')
  assert.equal(view.round.label, 'rodada mais recente')
  assert.equal(view.round.parcels.find(item => item.key === 'cacheWriteTokens').value, 'não informado')
  assert.equal(view.round.parcels.find(item => item.key === 'inputTokens').value, '150')
  assert.equal(view.round.weightLabel, null, 'partial counters cannot become a fabricated complete weight')
  assert.match(view.round.scopeNote, /rodada/u)
  assert.equal(costSignals.guiUsageMetersPresentation(null), null)
  const waiting = costSignals.guiUsageMetersPresentation({ conversation: usage, round: { id: 'next', usage: null } })
  assert.equal(waiting.round.valueLabel, 'aguardando medição')
})

test('rendered usage groups expose separate scopes and accessible raw parcel disclosure', () => {
  const compiled = buildSync({ entryPoints: ['src/renderer/src/components/GuiContextPanel.tsx'],
    bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic',
    loader: { '.css': 'empty' }, external: ['react', 'react-dom'] }).outputFiles[0].text
  const module = { exports: {} }
  new Function('require', 'module', 'exports', compiled)(createRequire(import.meta.url), module, module.exports)
  const usage = { apiCalls: 1, inputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 200, outputTokens: null }
  const view = costSignals.guiUsageMetersPresentation({ conversation: { ...usage, inputTokens: 5_000 },
    round: { id: 'synthetic', usage } })
  const html = renderToStaticMarkup(createElement('dl', { className: 'gui-context-metrics' },
    createElement(module.exports.GuiUsageGroup, { group: view.round }),
    createElement(module.exports.GuiUsageGroup, { group: view.conversation })))
  assert.match(html, /<dt>rodada mais recente<\/dt>/u)
  assert.match(html, /<dt>total da conversa<\/dt>/u)
  assert.match(html, /<summary>parcelas em tokens<\/summary>/u)
  assert.match(html, /<dt>saída<\/dt><dd>não informado<\/dd>/u)
  assert.match(html, /<dt>entrada nova<\/dt><dd>100<\/dd>/u)
  assert.match(html, /<dt>entrada nova<\/dt><dd>5\.000<\/dd>/u)
  assert.doesNotMatch(html, /tokens-peso/u, 'incomplete output cannot produce a complete cost estimate')
})

test('painel de contexto só mostra a fotografia canônica e preserva números exatos', () => {
  const withCost = guiContextPanelPresentation(51_234, 200_000, 0.0035)
  assert.deepEqual(withCost, {
    contextTokens: 51_234,
    contextWindow: 200_000,
    percent: 26,
    percentLabel: '26%',
    contextTokensLabel: '51.234',
    contextWindowLabel: '200.000',
    costLabel: '$0.0035',
    scopeNote: SCOPE_NOTE,
    tooltip: 'contexto: 51.234 de 200.000 tokens · 26% da janela · USD informado pelo motor (sessão) $0.0035'
  })

  const withoutCost = guiContextPanelPresentation(0, 200_000, null)
  assert.equal(withoutCost?.tooltip, 'contexto: 0 de 200.000 tokens · 0% da janela')
  assert.equal(guiContextPanelPresentation(10.5, 200_000), null)
  assert.equal(guiContextPanelPresentation(10, 0), null)
  assert.equal(guiContextPanelPresentation(10, 200_000, Number.NaN)?.costLabel, undefined)
  assert.equal(guiContextPanelPresentation(10, 200_000, -0.1)?.costLabel, undefined)
})

test('o custo mostra centavos quando há centavos e casas finas quando não há', () => {
  // O caso do dono: $9.650348 em seis casas lê como despejo de máquina.
  assert.equal(guiContextPanelPresentation(1, 200_000, 9.650348)?.costLabel, '$9.65')
  assert.equal(guiContextPanelPresentation(1, 200_000, 0.01)?.costLabel, '$0.01')
  // Abaixo de um centavo as casas são a única informação que existe: arredondar
  // mostraria "$0.00" para um gasto real.
  assert.equal(guiContextPanelPresentation(1, 200_000, 0.000_42)?.costLabel, '$0.00042')
  assert.equal(guiContextPanelPresentation(1, 200_000, 0.0035)?.costLabel, '$0.0035')
})

test('o painel diz o ESCOPO dos números — os dois se leem errado sem isso', () => {
  const component = readWorkspaceFile('src/renderer/src/components/GuiContextPanel.tsx')
  const css = readWorkspaceFile('src/renderer/src/global.css')

  // Caso real de 2026-08-17: chat de planejamento RETOMADO, o dono pediu um
  // plano e leu meio milhão de tokens e ~$9,65. Os dois números estavam certos
  // e nenhum era sobre o que ele acabara de pedir.
  assert.match(SCOPE_NOTE, /última medição/u)
  assert.match(SCOPE_NOTE, /acumulado informado pelo motor desde que a sessão abriu/u)
  assert.match(component, /<p className="gui-context-scope">\{usage\.scopeNote\}<\/p>/u)
  // O rótulo "usados" prometia o gasto da última pergunta.
  assert.doesNotMatch(component, /<dt>usados<\/dt>/u)
  assert.match(component, /<dt>contexto<\/dt>/u)
  assert.match(component, /<dt>USD do motor · sessão<\/dt>/u)
  // A nota é texto CORRIDO: --ink-3 dá 3,00:1 sobre --card (medido) e o piso de
  // leitura é 4,5:1. --ink-2 dá 6,32:1 e mantém a hierarquia pelo tamanho.
  assert.match(css, /\.gui-context-scope\s*\{[^}]*color: var\(--ink-2\)/su)
})

test('integração usa botão discreto, popover nomeado e restauração de foco', () => {
  const component = readWorkspaceFile('src/renderer/src/components/GuiContextPanel.tsx')
  const pane = readWorkspaceFile('src/renderer/src/components/GuiPane.tsx')
  const css = readWorkspaceFile('src/renderer/src/global.css')

  assert.match(component, /<button[\s\S]*aria-haspopup="dialog"/u)
  assert.match(component, /aria-expanded=\{open\}/u)
  assert.match(component, /role="dialog"/u)
  assert.match(component, /tabIndex=\{-1\}/u)
  assert.match(component, /event\.key !== 'Escape'/u)
  assert.match(component, /triggerRef\.current\?\.focus/u)
  assert.match(component, /data-tip=\{tip\}/u)
  assert.match(component, /usage\.costLabel &&/u)
  assert.match(pane, /<GuiContextPanel/u)
  assert.match(pane, /open=\{openMenu === 'context'\}/u)
  assert.match(pane, /guiContextPanelPresentation\(/u)
  assert.match(css, /\.gui-context-trigger\s*\{/u)
  assert.match(component, /createPortal\(/u)
  assert.match(component, /closest<HTMLElement>\('\.gui-pane'\)/u)
  assert.match(component, /gui-context-popover gui-menu-host/u)
  assert.match(css, /\.gui-context-popover\.gui-menu-host\s*\{[^}]*position: absolute;[^}]*overflow-y: auto/su)
  assert.match(css, /\.gui-context-trigger:focus-visible/u)
})

test('context dialog stays inside narrow chats even when the compact trigger moves left', () => {
  for (const width of [180, 240, 280, 320, 420, 900]) {
    const pane = { left: 41, top: 25, right: 41 + width, bottom: 583 }
    const box = guiContextPopoverLayout({ left: 91, right: 159, top: 534, bottom: 562 },
      pane, { width: 1050, height: 700 }, 264)
    assert.ok(box.left >= pane.left + 8)
    assert.ok(box.left + box.width <= pane.right - 8)
    assert.ok(box.top >= pane.top + 8)
    assert.ok(box.top + Math.min(264, box.maxHeight) < 534)
  }
})

test('short context dialogs choose available space and cap scrolling inside the viewport', () => {
  const pane = { left: -30, right: 300, top: 0, bottom: 500 }
  const box = guiContextPopoverLayout({ left: 40, right: 100, top: 25, bottom: 53 },
    pane, { width: 240, height: 200 }, 340)
  assert.equal(box.left, 8)
  assert.equal(box.width, 224)
  assert.equal(box.top, 62)
  assert.equal(box.maxHeight, 130)
})

test('o painel de contexto é leitura: o turno em andamento não o fecha', () => {
  const pane = readWorkspaceFile('src/renderer/src/components/GuiPane.tsx')

  // A guarda existe para os SELETORES DE EXECUTOR (conta/modelo/effort/modo),
  // cuja escolha não pode mudar no meio de um turno. O contexto não muda nada
  // do próximo turno — fechá-lo junto era efeito colateral, e o botão nem
  // sequer aparece desabilitado: parecia vivo e morria no clique.
  assert.match(
    pane,
    /if \(working && openMenu && openMenu !== 'attach' && openMenu !== 'context'\) setOpenMenu\(null\)/u
  )
})

test('medição que some fecha o painel pelo caminho normal, sem largar o foco', () => {
  const component = readWorkspaceFile('src/renderer/src/components/GuiContextPanel.tsx')

  // O painel é montado condicionalmente (`if (!usage) return null`). Quando os
  // números somem com o popover ABERTO — o `thread/compacted` do Codex zera os
  // dois —, arrancar o diálogo com o foco dentro deixaria o foco no <body>.
  assert.match(component, /useEffect\(\(\) => \{\s*if \(!usage && open\) onOpenChange\(false\)/u)
  const guard = component.indexOf('if (!usage) return null')
  const closer = component.indexOf('if (!usage && open) onOpenChange(false)')
  assert.notEqual(closer, -1)
  assert.ok(closer < guard, 'o efeito de fechamento vem ANTES do return null')
})

// ————— R25 — O PAINEL PASSA A DIZER O CUSTO, NÃO SÓ A OCUPAÇÃO —————
//
// O medidor de janela responde "quanto cabe ainda"; a queixa do dono
// (2026-08-20) foi outra: "contexto 7%, mas já foi 10% da cota". O painel ganha
// as duas leituras que faltavam — o ODÔMETRO da conversa (chamadas × peso) e a
// COTA REAL do seat desta conversa, esta última SEM nenhuma chamada nova: só o
// que o cache do poller já tem.

test('R25.1 — o odômetro mora no painel, com a física em UMA frase', () => {
  const component = readWorkspaceFile('src/renderer/src/components/GuiContextPanel.tsx')
  const pane = readWorkspaceFile('src/renderer/src/components/GuiPane.tsx')
  const css = readWorkspaceFile('src/renderer/src/global.css')

  // A linha do odômetro é uma linha da MESMA lista (mesma grade, mesmo popover):
  // custo não ganha painel próprio nem card flutuante. O que muda é a FORMA —
  // rótulo acima do valor, atrás de um fio, porque é outra régua.
  assert.match(component, /<dt>total da conversa<\/dt>/u)
  assert.match(component, /odometer\.valueLabel/u)
  assert.match(component, /odometer\.hint/u)
  assert.match(component, /className="gui-context-physics"/u)
  assert.match(component, /className="gui-context-cost gui-context-group"/u)
  assert.match(css, /\.gui-context-metrics \.gui-context-group\s*\{[^}]*border-top: 1px solid/su)
  assert.match(css, /\.gui-context-metrics > \.gui-context-cost\s*\{[^}]*display: block/su)
  // TOM pela régua de severidade dos medidores (sinal, não enfeite).
  assert.match(component, /gui-context-signal \$\{odometer\.tone\}/u)
  assert.match(css, /\.gui-context-signal\.hot\s*\{[^}]*color: var\(--err\)/su)
  assert.match(css, /\.gui-context-signal\.warm\s*\{[^}]*color: var\(--accent\)/su)
  // O pane calcula a apresentação a partir do que o main acumulou.
  assert.match(pane, /guiOdometerPresentation\(gui\.convCalls, gui\.convWeightTokens, gui\.contextTokens\)/u)
})

test('R25.2 — a cota do seat aparece no painel e NUNCA dispara coleta', () => {
  const component = readWorkspaceFile('src/renderer/src/components/GuiContextPanel.tsx')
  const pane = readWorkspaceFile('src/renderer/src/components/GuiPane.tsx')
  const preload = readWorkspaceFile('src/preload/index.ts')
  const ipc = readWorkspaceFile('src/main/ipc/misc.ts')
  const seatUsage = readWorkspaceFile('src/main/seatUsage.ts')

  assert.match(component, /seat\.valueLabel/u)
  assert.match(component, /seat\.label/u)
  // O pane lê SÓ o cache (`peek`): o poller/hover continua sendo o único que
  // spawna processo — a cota no chat não pode inventar uma chamada por pane.
  // A ponte é referenciada com guarda (ponte antiga degrada inerte) e chamada
  // pelo nome local: os dois pinos abaixo cobrem referência e chamada.
  assert.match(pane, /window\.synkora\.seats\.usagePeek/u)
  assert.match(pane, /void peek\(seatId\)/u)
  assert.doesNotMatch(pane, /seats\.usage\(/u)
  assert.match(preload, /usagePeek: \(id: string\): Promise<SeatUsage \| null> =>/u)
  assert.match(ipc, /ipcMain\.handle\('seats:usagePeek'/u)
  assert.match(seatUsage, /export function peekSeatUsage/u)
  // A prova de que o peek não coleta: ele não conhece nenhum dos coletores.
  const peek = seatUsage.slice(seatUsage.indexOf('export function peekSeatUsage'))
  const body = peek.slice(0, peek.indexOf('\n}\n') + 2)
  assert.doesNotMatch(body, /claudeUsage|codexUsage|spawn\(/u)
})

test('R25.3b — conversa pesada avisa no MEDIDOR (tooltip + forma + painel), nunca no fio', () => {
  // Ordem do dono (2026-09-16): a nota no fio "é feia; um aviso em tooltip
  // seria melhor". A receita das três saídas continua inteira — só mudou de
  // casa: tooltip do medidor de contexto, moldura tracejada no chip (forma
  // antes de cor) e uma linha no painel aberto.
  assert.equal(guiHeavyConversationTip(149_999), null, 'abaixo do limiar o chip fica quieto')
  assert.equal(guiHeavyConversationTip(null), null)
  assert.equal(guiHeavyConversationTip(Number.NaN), null)
  const tip = guiHeavyConversationTip(453_200)
  assert.match(tip, /re-lê ~453k tokens a cada mensagem/u, 'o número medido, não um adjetivo')
  assert.match(tip, /\/compact/u)
  assert.match(tip, /missão/u)
  assert.match(tip, /ciente do custo/u)

  const pane = readWorkspaceFile('src/renderer/src/components/GuiPane.tsx')
  const component = readWorkspaceFile('src/renderer/src/components/GuiContextPanel.tsx')
  const css = readWorkspaceFile('src/renderer/src/global.css')
  const sessions = readWorkspaceFile('src/main/guiSessions.ts')
  assert.match(pane, /guiHeavyConversationTip\(gui\.contextTokens\)/u)
  assert.match(pane, /heavy=\{heavyTip\}/u)
  assert.match(component, /const tip = heavy \? /u, 'o tooltip do chip carrega a receita quando pesa')
  assert.match(component, /heavy \? ' heavy' : ''/u, 'o chip muda de FORMA')
  assert.match(component, /className="gui-context-heavy"/u, 'a receita também mora no painel aberto')
  assert.match(css, /\.gui-context-trigger\.heavy\s*\{[^}]*border-style: dashed/su)
  assert.doesNotMatch(sessions, /command-output', text: note/u, 'o fio não recebe mais a nota')
})

test('R25.3 — trocar modelo/effort/⚡ em conversa pesada avisa no próprio menu', () => {
  const pane = readWorkspaceFile('src/renderer/src/components/GuiPane.tsx')

  // Armadilha documentada e agora MEDIDA: trocar modelo/effort/fast quebra a
  // chave do prompt-cache e re-escreve o contexto inteiro. O clique segue
  // livre (advisory), mas o número aparece antes dele.
  assert.match(pane, /guiExpensiveSwitchNote\(gui\.contextTokens\)/u)
  const noteUses = pane.match(/\{switchNote &&/gu) ?? []
  assert.ok(noteUses.length >= 2, 'a nota tem de aparecer no menu de modelo E no de effort')
  assert.match(pane, /className="gui-menu-foot gui-menu-cost"/u)
  // O ⚡ não tem menu: a nota entra na dica dele, sem virar botão desabilitado.
  assert.match(pane, /switchNote \? `\$\{[^`]*\} · \$\{switchNote\}`/u)
})

// ————— R25 — OS SINAIS DE CUSTO, EM MÓDULO PURO —————

test('R25.1 — o odômetro se apresenta em chamadas + peso, com a física em uma frase', () => {
  const odometer = guiOdometerPresentation(139, 3_596_250, 192_000)
  assert.equal(odometer.calls, 139)
  assert.equal(odometer.valueLabel, '139 registros de uso · ~3.6 mi tokens-peso (estimativa)')
  assert.equal(odometer.hint, 'tokens-peso é uma estimativa ponderada; não é cache bruto nem a fórmula da cota da assinatura.')
  assert.equal(odometer.tone, 'hot')
  assert.match(odometer.tooltip, /total da conversa: 139 registros de uso/u)

  // Singular é singular: "1 chamadas" é despejo de máquina.
  assert.equal(guiOdometerPresentation(1, 31_250, 30_000).valueLabel, '1 registro de uso · ~31.3 mil tokens-peso (estimativa)')

  // TOM pela MESMA régua dos medidores do titlebar, aplicada à cota (não à
  // janela): o limiar da nota (150k) é o 100% dessa régua, então o sinal
  // esquenta um pouco ANTES de o app abrir a boca.
  assert.equal(guiOdometerPresentation(3, 1_000, 10_000).tone, 'cool')
  assert.equal(guiOdometerPresentation(3, 1_000, 95_000).tone, 'warm')
  assert.equal(guiOdometerPresentation(3, 1_000, 130_000).tone, 'hot')
  // Sem contexto medido o tom não inventa gravidade.
  assert.equal(guiOdometerPresentation(3, 1_000, null).tone, 'cool')

  // Nada medido = nada mostrado (a UI esconde, não escreve zero).
  assert.equal(guiOdometerPresentation(null, null, 10), null)
  assert.equal(guiOdometerPresentation(0, 0, 10), null)
  assert.equal(guiOdometerPresentation(2, -1, 10), null)
  assert.equal(guiOdometerPresentation(2.5, 100, 10), null)
})

test('R25.2 — a cota do seat mostra o medidor do CLI e a idade da leitura', () => {
  const now = Date.UTC(2026, 7, 20, 15, 0, 0)
  const claude = {
    at: now - 90_000,
    meters: [
      { label: 'sessão', pct: 81, mode: 'used', severity: 0.81, reset: '15:50' },
      { label: 'semana (geral)', pct: 19, mode: 'used', severity: 0.19, reset: '25/08 03:00' }
    ],
    lines: []
  }
  const seat = guiSeatQuotaPresentation(claude, now)
  // O PRIMEIRO medidor é a janela curta nos dois CLIs (a ordem é a do próprio
  // CLI): é ela que estoura no meio do trabalho.
  assert.equal(seat.label, 'sessão')
  assert.equal(seat.valueLabel, '81% usado · reseta 15:50')
  assert.equal(seat.tone, 'warm')
  assert.equal(seat.ageLabel, undefined, 'leitura fresca não precisa se explicar')

  // O codex conta o que RESTA — a direção do medidor dele é preservada.
  const codex = {
    at: now - 12 * 60_000,
    meters: [{ label: 'geral', pct: 8, mode: 'left', severity: 0.92, reset: '18:20', window: '5h' }],
    lines: []
  }
  const outro = guiSeatQuotaPresentation(codex, now)
  assert.equal(outro.valueLabel, 'restam 8% · reseta 18:20')
  assert.equal(outro.tone, 'hot')
  // Sem chamada nova, a leitura envelhece — e ela DIZ a idade em vez de mentir.
  assert.equal(outro.ageLabel, 'há 12 min')

  // Velha demais some: uma janela de 5h já resetou, e o número viraria susto.
  assert.equal(guiSeatQuotaPresentation({ ...codex, at: now - 7 * 3_600_000 }, now), null)
  assert.equal(guiSeatQuotaPresentation({ at: now, meters: [], lines: ['sem dados'] }, now), null)
  assert.equal(guiSeatQuotaPresentation(null, now), null)
})

test('R25.3 — a nota da troca cara só aparece acima do limiar, e é só o número', () => {
  assert.equal(guiExpensiveSwitchNote(149_000), null)
  assert.equal(guiExpensiveSwitchNote(176_669), 'a troca pode afetar o reaproveitamento de ~177k tokens de contexto')
  assert.equal(guiExpensiveSwitchNote(null), null)
  assert.equal(guiExpensiveSwitchNote(Number.NaN), null)
  // Advisory: nenhuma proibição, nenhum dinheiro.
  assert.doesNotMatch(guiExpensiveSwitchNote(300_000), /\$|não pode|evite/iu)
})

test('R25 — a régua de severidade é UMA: o painel e o titlebar leem a mesma', () => {
  assert.equal(guiMeterTone(0), 'cool')
  assert.equal(guiMeterTone(0.59), 'cool')
  assert.equal(guiMeterTone(0.6), 'warm')
  assert.equal(guiMeterTone(0.84), 'warm')
  assert.equal(guiMeterTone(0.85), 'hot')
  assert.equal(guiMeterTone(2), 'hot')
  assert.equal(guiMeterTone(Number.NaN), 'cool')

  // Os medidores do titlebar param de carregar a cópia inline dessa régua.
  const meters = readWorkspaceFile('src/renderer/src/components/UsageMeters.tsx')
  assert.match(meters, /guiMeterTone\(m\.severity\)/u)
  assert.doesNotMatch(meters, /severity >= 0\.85/u)
})
