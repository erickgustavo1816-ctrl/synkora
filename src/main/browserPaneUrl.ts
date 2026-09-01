/**
 * BROWSER EMBUTIDO — O ENDEREÇO DO DONO e a SESSÃO DO PROJETO (metade PURA de
 * `./browserPane`, cortada em 2026-09-01 pela regra da casa: aquele arquivo
 * cruzou ~1000 linhas de novo quando a aba ganhou dono).
 *
 * Duas funções puras, sem uma linha de Electron e sem estado nenhum: a
 * normalização do endereço — o que o dono digita na barra e o que o agente manda
 * no `browser_open` passam pela MESMA porta — e o nome da partition por projeto.
 *
 * O corte é de ENDEREÇO, não de contrato: `./browserPane` RE-EXPORTA as duas, e
 * nenhum consumidor muda uma linha (a suíte `test:browser-pane` continua
 * importando-as de lá).
 */
import { pathToFileURL } from 'node:url'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'])

function looksLocal(host: string): boolean {
  const bare = host.replace(/:\d+$/, '').toLowerCase()
  return LOCAL_HOSTS.has(bare) || bare.endsWith('.localhost')
}

/**
 * "URL do dono: normalizada (https default), qualquer URL — o browser é dele."
 * Duas emendas pagas por realidade, não por gosto:
 * - **localhost sai em http**, não https: o caso de uso número um é o dev
 *   server da missão (`localhost:5173`), e https ali só entrega tela de erro;
 * - **`javascript:` é recusado** nomeando a receita: ele executaria no
 *   documento ATUAL (o canal de código é `browser_eval`, da H2).
 * Texto que não é endereço NÃO vira busca: nenhum buscador foi decidido e o
 * app não manda o que o dono digitou para um terceiro por conta própria.
 */
export function normalizeBrowserUrl(raw: unknown): { ok: true; url: string } | { ok: false; error: string } {
  const input = typeof raw === 'string' ? raw.trim() : ''
  if (!input) return { ok: false, error: 'digite um endereço para navegar' }
  const invalid = { ok: false as const, error: `endereço inválido: ${input.slice(0, 120)}` }
  // Caminho do Windows colado (`C:\build\index.html`) ou UNC — vira file://.
  if (/^[a-zA-Z]:[\\/]/.test(input) || input.startsWith('\\\\')) {
    try {
      return { ok: true, url: pathToFileURL(input).href }
    } catch {
      return invalid
    }
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(input)
  const proto = scheme?.[1].toLowerCase()
  if (proto === 'javascript' || proto === 'vbscript') {
    return {
      ok: false,
      error: `endereço ${proto}: não navega — para rodar código NA página use a tool browser_eval`
    }
  }
  // ARMADILHA PAGA: `localhost:5173` casa o regex de esquema — o `localhost:`
  // vira protocolo e o `new URL` ACEITA, devolvendo um endereço que não abre
  // nada. O discriminador é o que vem depois dos dois pontos: dígito = PORTA.
  const hierarchical = /^[a-z][a-z0-9+.-]*:\/\//i.test(input)
  const opaque = Boolean(scheme) && !/^[a-z][a-z0-9+.-]*:\d/i.test(input)
  if (hierarchical || opaque) {
    try {
      return { ok: true, url: new URL(input).href }
    } catch {
      return invalid
    }
  }
  const host = input.split(/[/?#]/)[0] ?? ''
  // Texto que não é endereço NÃO vira busca: nenhum buscador foi decidido, e o
  // app não manda o que o dono digitou para um terceiro por conta própria.
  if (/\s/.test(input) || (!/[.:]/.test(input) && !looksLocal(host))) {
    return {
      ok: false,
      error: 'isso não parece um endereço — digite algo como localhost:5173 ou cole o link completo (https://…)'
    }
  }
  const guess = `${looksLocal(host) ? 'http' : 'https'}://${input}`
  try {
    return { ok: true, url: new URL(guess).href }
  } catch {
    return invalid
  }
}

/** `persist:browser:<projectId>` (D5.3) — login vale para todas as missões do
 *  projeto. O id é uuid, mas a partition é sanitizada por precaução. */
export function browserPartitionFor(projectId: string): string {
  const safe = projectId.replace(/[^a-zA-Z0-9_-]/g, '') || 'sem-projeto'
  return `persist:browser:${safe}`
}

/**
 * O ALVO DE QUEM ABRE UMA ABA — a mesma normalização, com a porta do VAZIO.
 * `browser_open` sem `url` e o `+` do dono abrem uma aba EM BRANCO; qualquer
 * outra coisa passa pela régua do dono acima (`localhost:5173` é o alvo mais
 * provável de um QA e, cru, não abre nada).
 *
 * Mora aqui desde o corte dos GESTOS (2026-09-01) porque agora são duas as
 * bocas que a chamam — o `ensureTab` do agente (no motor) e o `+`/barra de URL
 * do dono (em `./browserPaneGestures`) —, e duas cópias virariam duas réguas.
 */
export function normalizeBrowserTarget(
  url: string | undefined
): { ok: true; url: string | undefined } | { ok: false; error: string } {
  if (url === undefined || url === '') return { ok: true, url: undefined }
  const normalized = normalizeBrowserUrl(url)
  return normalized.ok ? { ok: true, url: normalized.url } : normalized
}
