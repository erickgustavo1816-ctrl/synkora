import type { VersionReleaseRecord } from './store'

// RIGHTDOCK Onda B (2026-08-22) — a LINHA da "última subida" no trilho do
// release, fora do React de propósito (padrão da casa: a conta que decide o
// que a tela diz mora num módulo puro, provado em node).
//
// REGRA DE HONESTIDADE: a linha nunca afirma além do que o registro prova. O
// mockup escreve "caixa publicada", mas `publishRequired` só diz que o produto
// DECLARA pipeline de caixa (scripts.release) — então a linha diz a receita.
// E bump que ALINHOU é redundante com o nome da versão; só a falha é notícia.

/** O push tem três desfechos reais — e "sem remoto" não é falha nem silêncio:
 *  o projeto sem GitHub sobe local de propósito. */
export function releasePushWord(push: VersionReleaseRecord['push']): string {
  if (!push.attempted) return 'sem remoto'
  return push.ok ? 'push ok' : 'push falhou'
}

function two(n: number): string {
  return String(n).padStart(2, '0')
}

/** dd/mm hh:mm na hora LOCAL da máquina do dono (mesma régua do
 *  `toLocaleString` da aba Versões); data ilegível cala em vez de virar
 *  "Invalid Date" na tela. */
export function releaseDayTime(iso: string): string | null {
  const at = new Date(iso)
  if (!Number.isFinite(at.getTime())) return null
  return `${two(at.getDate())}/${two(at.getMonth() + 1)} ${two(at.getHours())}:${two(at.getMinutes())}`
}

/** A linha inteira: `⇧ V1.0.5 · 21/08 17:15 · push ok · caixa (npm run
 *  release)`. Pedaço sem fonte simplesmente não entra. */
export function releasePortraitLine(record: VersionReleaseRecord): string {
  const parts = [`⇧ ${record.versionName}`]
  const when = releaseDayTime(record.at)
  if (when) parts.push(when)
  parts.push(releasePushWord(record.push))
  if (record.bump && !record.bump.committed) parts.push('manifesto não alinhado')
  if (record.publishRequired) parts.push('caixa (npm run release)')
  return parts.join(' · ')
}
