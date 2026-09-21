// O SELO DE VERSÃO DO RAIL — a apresentação PURA (missão "Atualização do
// Synkora", 2026-09-21). O main (`appUpdate.ts`, via electron-updater) publica
// um `AppUpdateStatus`; aqui ele vira o que o pé do rail dos universos mostra:
// o número, o gesto, a dica e a ação de um clique. Nenhum DOM, nenhum IPC —
// tudo testável em node puro (scripts/test-app-update-badge.mjs).
//
// A régua visual (docs/MOCKUP_WORKSPACE.md): diferença dita por FORMA antes de
// cor; movimento é SINAL. Em dia = número quieto. Baixando = anel que enche.
// Pronto = pílula cheia no acento, pulsando devagar: a decisão é do dono
// (reiniciar), e o rail é o único lugar visível de QUALQUER universo.

import type { AppUpdateStatus } from '../../preload'

/** Espelho declarado de `AppUpdateStatus` (src/preload/index.ts) — o renderer
 *  só conhece o contrato, nunca o electron-updater. */
export type { AppUpdateStatus, AppUpdatePhase } from '../../preload'

export type AppUpdateTone = 'quiet' | 'busy' | 'ready' | 'warn'

export type AppUpdateAction = 'check' | 'download' | 'install' | 'none'

export interface AppUpdateBadgeView {
  /** o número que aparece no selo (a versão que RODA, ou a que vem) */
  label: string
  /** glifo curto ao lado do número; vazio em dia */
  glyph: string
  tone: AppUpdateTone
  /** 0..100 quando há download em curso; null fora dele */
  percent: number | null
  /** a dica completa (data-tip), com a receita do clique */
  tip: string
  /** o que um clique faz */
  action: AppUpdateAction
  /** nome acessível do botão */
  ariaLabel: string
}

const RELATIVE_STEPS: [number, string][] = [
  [60_000, 'agora há pouco'],
  [3_600_000, 'há {n} min'],
  [86_400_000, 'há {n} h']
]

/** "agora há pouco" · "há 12 min" · "há 3 h" · "há 2 d" */
export function appUpdateRelativeTime(at: number | undefined, now: number): string {
  if (at === undefined || !Number.isFinite(at)) return ''
  const elapsed = Math.max(0, now - at)
  for (const [limit, template] of RELATIVE_STEPS) {
    if (elapsed < limit) {
      const unit = limit === 60_000 ? 1 : limit === 3_600_000 ? 60_000 : 3_600_000
      return template.replace('{n}', String(Math.max(1, Math.floor(elapsed / unit))))
    }
  }
  return `há ${Math.max(1, Math.floor(elapsed / 86_400_000))} d`
}

function megabytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return ''
  return `${(bytes / 1_048_576).toFixed(1)} MB`
}

export function appUpdateBadgeView(status: AppUpdateStatus | null, now: number): AppUpdateBadgeView {
  if (!status) {
    return {
      label: '…',
      glyph: '',
      tone: 'quiet',
      percent: null,
      tip: 'Synkora — lendo a versão',
      action: 'none',
      ariaLabel: 'Versão do Synkora'
    }
  }
  const version = status.version
  switch (status.phase) {
    case 'unsupported':
      return {
        label: version,
        glyph: '',
        tone: 'quiet',
        percent: null,
        tip: `Synkora ${version}\n${status.reason ?? 'atualização automática indisponível nesta execução'}`,
        action: 'none',
        ariaLabel: `Synkora ${version}`
      }
    case 'idle':
      return {
        label: version,
        glyph: '',
        tone: 'quiet',
        percent: null,
        tip: `Synkora ${version}\nclique para verificar se há versão nova`,
        action: 'check',
        ariaLabel: `Synkora ${version} — verificar atualização`
      }
    case 'checking':
      return {
        label: version,
        glyph: '◌',
        tone: 'busy',
        percent: null,
        tip: `Synkora ${version}\nverificando se há versão nova…`,
        action: 'none',
        ariaLabel: `Synkora ${version} — verificando`
      }
    case 'current': {
      const when = appUpdateRelativeTime(status.checkedAt, now)
      return {
        label: version,
        glyph: '',
        tone: 'quiet',
        percent: null,
        tip: `Synkora ${version} — em dia${when ? ` (verificado ${when})` : ''}\nclique para verificar de novo`,
        action: 'check',
        ariaLabel: `Synkora ${version} — em dia`
      }
    }
    case 'available':
      return {
        label: status.next ?? version,
        glyph: '↓',
        tone: 'busy',
        percent: null,
        tip: `Synkora ${status.next ?? '?'} disponível (você usa ${version})\nclique para baixar agora`,
        action: 'download',
        ariaLabel: `Synkora ${status.next ?? ''} disponível — baixar`
      }
    case 'downloading': {
      const percent = Math.max(0, Math.min(100, Math.round(status.percent ?? 0)))
      const size = status.total ? ` · ${megabytes(status.transferred)} de ${megabytes(status.total)}` : ''
      return {
        label: status.next ?? version,
        glyph: '↓',
        tone: 'busy',
        percent,
        tip: `baixando o Synkora ${status.next ?? ''} — ${percent}%${size}\ninstala sozinho quando você reiniciar`,
        action: 'none',
        ariaLabel: `baixando o Synkora ${status.next ?? ''} — ${percent}%`
      }
    }
    case 'ready':
      return {
        label: status.next ?? version,
        glyph: '↻',
        tone: 'ready',
        percent: 100,
        tip: `Synkora ${status.next ?? ''} pronto para instalar\nclique para reiniciar e atualizar — as conversas abertas voltam depois`,
        action: 'install',
        ariaLabel: `Synkora ${status.next ?? ''} pronto — reiniciar e atualizar`
      }
    case 'error': {
      const when = appUpdateRelativeTime(status.checkedAt, now)
      return {
        label: version,
        glyph: '!',
        tone: 'warn',
        percent: null,
        tip: `Synkora ${version}\n${status.error ?? 'não consegui verificar atualizações'}${when ? ` (${when})` : ''}\nclique para tentar de novo`,
        action: 'check',
        ariaLabel: `Synkora ${version} — falha ao verificar; tentar de novo`
      }
    }
  }
}
