import {
  unversionedRefusal,
  type ProjectFolderInspection,
  type ProjectVersioning
} from '../../shared/projectVersioning'
import { noticeSentence } from './noticeStack'
import { folderName } from './util'

// ————————————————————————————————————————————————————————————————————————
// O MODAL DE NOVO UNIVERSO, EM CONTAS (projeto sem versionamento, 2026-09-30;
// mockup aprovado: docs/mockups/projeto-sem-versao-2026-09-30.html, cena 1).
//
// Puro: nenhum store, nenhum DOM. O modal pergunta aqui o que o interruptor
// "Versionar com Git" mostra, qual pedido sai para o main e em que lugar da
// folha um erro devolvido deve aparecer; scripts/test-new-universe-modal.mjs
// prova as regras pelo componente.
// ————————————————————————————————————————————————————————————————————————

/** O que se sabe da pasta escolhida. `unknown` = a leitura falhou (main velho,
 *  pasta que sumiu): vale "não sei" e NUNCA bloqueia o modal — o main segue
 *  sendo a autoridade que recusa. */
export type FolderCheck =
  | { state: 'none' }
  | { state: 'checking' }
  | { state: 'known'; inspection: ProjectFolderInspection }
  | { state: 'unknown' }

export const NO_FOLDER: FolderCheck = { state: 'none' }

/** Pasta com Git só nasce versionada (decisão do dono, 2026-09-30). */
export function folderLocksVersioning(check: FolderCheck): boolean {
  return check.state === 'known' && check.inspection.hasGit
}

export interface VersioningSwitchView {
  checked: boolean
  locked: boolean
  /** a palavra do estado, ao lado do trilho */
  word: 'ligado' | 'desligado'
  /** a frase de uma linha que diz a consequência */
  hint: string
}

const HINT_ON = 'Missões em paralelo, cada uma isolada, entregues por versão.'
const HINT_OFF = 'Uma missão por vez, e o que ela faz vale direto na pasta.'
const HINT_LOCKED = 'Esta pasta já tem Git, então o universo nasce versionado.'

/** O interruptor diz o estado LIGADO ("Versionar com Git"). Travado, fica
 *  ligado e explica por quê — a vontade do dono não vence a pasta. */
export function versioningSwitchView(wantsGit: boolean, check: FolderCheck): VersioningSwitchView {
  const locked = folderLocksVersioning(check)
  const checked = locked || wantsGit
  return {
    checked,
    locked,
    word: checked ? 'ligado' : 'desligado',
    hint: locked ? HINT_LOCKED : checked ? HINT_ON : HINT_OFF
  }
}

export interface NewUniverseDraft {
  name: string
  path: string
  gitUrl: string
  wantsGit: boolean
}

/** O pedido do modal. Espelho estrutural de `NewProjectInput` (store.ts) —
 *  módulo puro não importa o store. */
export interface NewUniverseRequest {
  name: string
  path: string
  gitUrl?: string
  versioning: ProjectVersioning
}

/** Desligado não leva link: o main recusaria (`git-remote`) e o campo já
 *  sumiu da tela — um link digitado antes de desligar não pode vazar. */
export function newUniverseRequest(draft: NewUniverseDraft, check: FolderCheck): NewUniverseRequest {
  const versioning: ProjectVersioning = versioningSwitchView(draft.wantsGit, check).checked ? 'git' : 'none'
  const gitUrl = versioning === 'git' ? draft.gitUrl.trim() : ''
  return {
    // o nome que o universo ganha quando o dono não escreve um: o da pasta
    name: draft.name.trim() || folderName(draft.path) || 'universo',
    path: draft.path,
    ...(gitUrl ? { gitUrl } : {}),
    versioning
  }
}

/** Onde o erro aparece: no interruptor, no campo do link ou no pé da folha. */
export type CreateErrorSlot = 'versioning' | 'remote' | 'form'

/**
 * O erro mora ONDE quebrou. Sinal estrutural, nunca adivinhação sobre o
 * texto: as recusas do modo são o contrato `unversionedRefusal` (igualdade
 * exata); com link, a única falha dura do main é o clone (pasta vazia ou
 * inexistente) — com a pasta sabidamente cheia o link vira remoto com aviso,
 * então um erro ali veio de outro lugar e vai para o pé.
 */
export function createErrorSlot(error: string, sent: NewUniverseRequest, check: FolderCheck): CreateErrorSlot {
  if (error === unversionedRefusal('git-folder')) return 'versioning'
  if (error === unversionedRefusal('git-remote')) return 'remote'
  if (!sent.gitUrl) return 'form'
  const knownFull = check.state === 'known' && check.inspection.exists && !check.inspection.empty
  return knownFull ? 'form' : 'remote'
}

/** A recusa `git-folder` é a prova de que a pasta tem Git: o modal passa a
 *  saber disso e trava o interruptor, em vez de deixar o dono tentar de novo. */
export function folderCheckAfterError(error: string, check: FolderCheck): FolderCheck {
  if (error !== unversionedRefusal('git-folder')) return check
  const inspection = check.state === 'known' ? check.inspection : { exists: true, empty: false }
  return { state: 'known', inspection: { ...inspection, hasGit: true } }
}

/** O texto do main vira frase da folha: maiúscula no começo e ponto no fim
 *  (os erros do main chegam em minúscula e sem ponto final). */
export function errorSentence(text: string): string {
  const sentence = noticeSentence(text)
  return !sentence || /[.!?…]$/.test(sentence) ? sentence : `${sentence}.`
}
