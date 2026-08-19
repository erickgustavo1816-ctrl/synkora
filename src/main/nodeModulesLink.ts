import { spawnSync } from 'child_process'
import { existsSync, lstatSync, symlinkSync } from 'fs'
import { join, resolve } from 'path'

// WORKTREE MOBILIADO (R15): todo worktree de missão/versão nascia vazio de
// node_modules e o dev queimava a primeira rodada diagnosticando "faltou
// instalar" (caso real do dono: typecheck reclamando dos tipos do Vite). A
// receita é a MESMA que o orquestrador já usa nos worktrees de agente: uma
// JUNCTION de `node_modules` apontando para o store do projeto — instantânea,
// sem download e sem privilégio de administrador (junction de diretório não
// exige o SeCreateSymbolicLinkPrivilege que o symlink exigiria no Windows).
//
// PAR DO INCIDENTE 02/08: aqui mora a metade que CRIA o link; a que o DESARMA
// é `neutralizeReparsePoints` (worktree.ts), nascida do dia em que uma junction
// de agente foi ATRAVESSADA por uma deleção recursiva e esvaziou o node_modules
// REAL do projeto. As duas metades andam juntas — criar link aqui só é seguro
// enquanto toda remoção continuar afunilando em `removeWorktreeAndBranch`, que
// desarma todo reparse point (remove o LINK, nunca o alvo) antes de deletar.

/**
 * `linked` = a junction acabou de ser criada; `already` = já havia algo em
 * `node_modules` no worktree (junction anterior OU pasta materializada por um
 * `npm install` de agente) e nada foi tocado; `no-source` = o projeto não tem
 * node_modules na raiz, então não há de onde mobiliar — não é erro; `{ error }`
 * = a criação falhou e o motivo é legível.
 */
export type NodeModulesLinkResult =
  | 'linked'
  | 'already'
  | 'no-source'
  /** O git deste worktree NÃO ignora `node_modules`: mobiliar aqui viraria
   *  milhares de untracked e `isWorktreeClean` diria "sujo" PARA SEMPRE — o ⇪
   *  da missão seria recusado no gate. Sem link é o mundo pré-R15, utilizável. */
  | 'not-ignored'
  | { error: string }

/** Existência do PRÓPRIO caminho, sem seguir link: junction pendurada (alvo já
 *  removido) também conta como ocupado — sobrescrever nunca é opção nossa. */
function entryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function failureText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.split(/\r?\n/)[0]?.trim().slice(0, 240) || 'o sistema de arquivos não explicou o motivo'
}

/**
 * Mobilia `worktreeDir` com o `node_modules` de `projectPath` por junction.
 *
 * Só age quando o projeto TEM node_modules na raiz e o worktree NÃO tem nada
 * nesse nome. Nunca lança: criar worktree não pode morrer por causa de
 * mobília — toda falha vira valor de retorno legível, e o worktree segue
 * utilizável (apenas sem a mobília).
 */
export function ensureNodeModulesLink(
  projectPath: string,
  worktreeDir: string
): NodeModulesLinkResult {
  if (!projectPath.trim() || !worktreeDir.trim()) {
    // Caminho vazio resolveria contra o cwd do app — o node_modules do PRÓPRIO
    // Synkora viraria alvo de uma junction em pasta arbitrária.
    return { error: 'caminho de projeto ou de worktree vazio' }
  }
  // Alvo SEMPRE absoluto: junction do Windows não guarda caminho relativo.
  const source = resolve(projectPath, 'node_modules')
  // `existsSync` segue o link de propósito: store do projeto que é ele mesmo
  // uma junction pendurada não tem o que compartilhar.
  if (!existsSync(source)) return 'no-source'
  const target = join(resolve(worktreeDir), 'node_modules')
  if (target === source) return 'already' // worktree É a raiz do projeto
  if (entryExists(target)) return 'already'
  // A CINTA DO IGNORE: só o veredito EXPLÍCITO "não ignorado" (exit 1) barra a
  // mobília. Qualquer outra falha do juiz (git ausente, pasta que nem é repo)
  // deixa o link seguir — sem repo não existe `isWorktreeClean` para proteger,
  // e recusar ali só devolveria o worktree vazio de sempre.
  // A barra final é OBRIGATÓRIA (sondado no git real): o padrão `node_modules/`
  // só casa diretório, e neste instante o diretório ainda não existe — sem a
  // barra o juiz responderia "não ignorado" para todo projeto são.
  const judged = spawnSync('git', ['-C', resolve(worktreeDir), 'check-ignore', '-q', 'node_modules/'], {
    windowsHide: true
  })
  if (judged.status === 1) return 'not-ignored'
  try {
    symlinkSync(source, target, 'junction')
    return 'linked'
  } catch (error) {
    return { error: failureText(error) }
  }
}
