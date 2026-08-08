/**
 * TRANSPLANTE DE SESSÃO ENTRE SEATS — módulo PURO (fase 1, commit 6a).
 *
 * Corpo movido VERBATIM do closure do whenReady em index.ts (cirurgia do
 * índice, docs/FASE1_MAPA_MAESTROENGINE.md §1 W12): zero dependências de
 * closure — só fs/path/app e o tipo SeatCli. Consumidores: o ⇄ de seat do
 * PM/orquestrador (ipc maestro:setSeat / missions:setOrchestratorSeat) e o
 * setPhaseExecutorImpl da troca de executor de fase.
 */
import { app } from 'electron'
import { dirname, join, relative } from 'path'
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'fs'
import type { SeatCli } from './seats'

/** TRANSPLANTE DE SESSÃO ENTRE SEATS (sondas 2026-08-04, ambas positivas:
 *  claude JSONL transplantado respondeu a palavra-código sob a outra conta;
 *  codex rollout recuperou a conversa inteira). O contexto é ARQUIVO LOCAL —
 *  a cobrança segue o login do config dir; copiar a conversa para o seat
 *  novo e resumir lá preserva tudo. Mesmo CLI apenas; false = chamador
 *  reseta a sessão como no fluxo antigo. */
export function migrateCliSessionBetweenSeats(
  cli: SeatCli,
  fromSeatId: string,
  toSeatId: string,
  cwd: string,
  sessionId: string
): boolean {
  try {
    const seatsRoot = join(app.getPath('userData'), 'seats')
    const from = join(seatsRoot, fromSeatId)
    const to = join(seatsRoot, toSeatId)
    if (cli === 'claude') {
      const slug = cwd.replace(/[^A-Za-z0-9]/g, '-')
      const src = join(from, 'projects', slug, `${sessionId}.jsonl`)
      if (!existsSync(src)) return false
      const destDir = join(to, 'projects', slug)
      mkdirSync(destDir, { recursive: true })
      copyFileSync(src, join(destDir, `${sessionId}.jsonl`))
      return true
    }
    const uuid = sessionId.replace('codex-thread:', '')
    const findRollout = (dir: string): string | undefined => {
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return undefined
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          const found = findRollout(full)
          if (found) return found
        } else if (entry.name.includes(uuid) && entry.name.endsWith('.jsonl')) {
          return full
        }
      }
      return undefined
    }
    const src = findRollout(join(from, 'sessions'))
    if (!src) return false
    const dest = join(to, relative(from, src))
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(src, dest)
    return true
  } catch {
    return false
  }
}
