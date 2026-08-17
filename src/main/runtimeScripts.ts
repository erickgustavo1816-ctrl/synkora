/**
 * Sondas do package.json de um workspace — o que o botão ▶ TERMINAL DE TESTE
 * precisa saber antes de montar a linha de comando do pane shell.
 *
 * Nasceu dentro do `qaRuntime.ts` (o harness subia o dev server para o gate de
 * QA da era F6). O gerente de runtime morreu com o pipeline de fases; estas
 * quatro leituras sobreviveram porque nunca foram sobre QA: são as respostas
 * de "qual script sobe este produto", "como instalo as dependências dele" e
 * "como passo uma porta para a ferramenta que ele usa". Nenhum processo nasce
 * aqui — quem spawna é o pane shell, sob o job object do PtyManager.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const RUNTIME_SCRIPT_PRIORITY = ['dev', 'preview', 'serve', 'start'] as const

/** Um script que abre janela própria não tem porta HTTP para receber. */
const ELECTRON_SCRIPT_RE = /\belectron(-vite|-forge|-builder)?\b/

/** Primeiro script de runtime declarado no package.json do workspace. */
export function detectRuntimeScript(cwd: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, unknown>
    }
    for (const name of RUNTIME_SCRIPT_PRIORITY) {
      const value = pkg.scripts?.[name]
      if (typeof value === 'string' && value.trim()) return name
    }
  } catch {
    // sem package.json legível = sem runtime detectável
  }
  return undefined
}

/** Comando de instalação pelo LOCKFILE (pnpm/yarn/bun não têm package-lock —
 * `npm ci` neles falharia; sem lockfile nenhum, npm install). */
export function installCommand(cwd: string): string {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm install --frozen-lockfile'
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn install --frozen-lockfile'
  if (existsSync(join(cwd, 'bun.lockb')) || existsSync(join(cwd, 'bun.lock')))
    return 'bun install'
  if (existsSync(join(cwd, 'package-lock.json'))) return 'npm ci'
  return 'npm install'
}

/** Corpo do script (para decidir COMO passar a porta — cada ferramenta tem a
 * sua sintaxe e `electron-vite dev` recusa `--port` com CACError). */
export function readScriptCommand(cwd: string, script: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, unknown>
    }
    const value = pkg.scripts?.[script]
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}

/**
 * Sufixo/prefixo de porta POR FERRAMENTA (caso real 2026-08-06: `npm run dev
 * -- --port 4002` num produto electron-vite morreu com "Unknown option
 * '--port'"). Electron abre janela própria — porta não se aplica; vite/astro
 * usam --port; next usa -p; ferramenta desconhecida recebe a convenção PORT=
 * no ambiente (CRA/express).
 */
export function portInvocation(
  scriptCommand: string,
  script: string,
  port: number | undefined,
  isWin: boolean
): { prefix: string; suffix: string; note?: string } {
  if (!port) return { prefix: '', suffix: '' }
  if (ELECTRON_SCRIPT_RE.test(scriptCommand))
    // CHECK 9.4 (2026-08-07): a porta escolhida VIAJA via PORT no ambiente —
    // produto PORT-aware a honra; config com strictPort pinado a ignora (a
    // nota é honesta sobre isso). Antes o prefixo vazio deixava o modal do
    // dono mudo mesmo com produto consertado.
    return {
      prefix: isWin ? `$env:PORT=${port}; ` : `PORT=${port} `,
      suffix: '',
      note: `porta ${port} enviada via PORT no ambiente — vale quando o produto a lê; config com porta pinada (strictPort) ainda a ignora`
    }
  if (/\bnext\b/.test(scriptCommand)) return { prefix: '', suffix: ` -- -p ${port}` }
  if (/\bvite\b|\bastro\b/.test(scriptCommand))
    return { prefix: '', suffix: ` -- --port ${port} --strictPort` }
  return {
    prefix: isWin ? `$env:PORT=${port}; ` : `PORT=${port} `,
    suffix: '',
    note: `ferramenta do script "${script}" não reconhecida — a porta foi passada pela convenção PORT=`
  }
}
