import { spawn } from 'child_process'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { MaestroSession } from './maestroSession'
import { freshWindowsPath } from './winPath'

// Limites de uso POR SEAT (hover no SeatRail) — dados REAIS dos CLIs:
// codex: `codex app-server` efêmero → account/read + account/rateLimits/read
//        (RPCs locais, zero tokens).
// claude: sessão stream-json efêmera rodando o /usage de verdade (comando
//        local do CLI — a saída é o mesmo texto do TUI).
// Cache de 5 min por seat; tudo best-effort (null = tooltip diz "sem dados").

/**
 * Um limite, já normalizado. `mode` preserva a DIREÇÃO de cada CLI: o claude
 * fala em quanto foi usado, o TUI do codex conta o que resta (decisão do
 * usuário, 2026-07-23 — espelhar o TUI). A UI desenha a barra na direção certa;
 * `severity` é a leitura única "quão apertado está isto", de 0 a 1.
 */
export interface UsageMeter {
  label: string
  /** 0..100 — significado dado por `mode` */
  pct: number
  mode: 'used' | 'left'
  /** 0..1, sempre "quanto do limite já foi consumido" */
  severity: number
  reset?: string
  window?: string
}

export interface SeatUsageInfo {
  at: number
  account?: string
  plan?: string
  meters: UsageMeter[]
  /** cru, só como rede: se nenhum medidor for reconhecido a UI ainda mostra algo */
  lines: string[]
}

const cache = new Map<string, SeatUsageInfo>()
const pending = new Map<string, Promise<SeatUsageInfo | null>>()
const CACHE_MS = 5 * 60_000

export function getSeatUsage(
  seatId: string,
  cli: 'claude' | 'codex',
  configDir: string
): Promise<SeatUsageInfo | null> {
  const hit = cache.get(seatId)
  if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit)
  const inFlight = pending.get(seatId)
  if (inFlight) return inFlight
  const job = (cli === 'codex' ? codexUsage(configDir) : claudeUsage(configDir))
    .then((res) => {
      if (!res || (res.meters.length === 0 && res.lines.length === 0)) return null
      const info: SeatUsageInfo = { at: Date.now(), ...res }
      cache.set(seatId, info)
      return info
    })
    .catch(() => null)
    .finally(() => pending.delete(seatId))
  pending.set(seatId, job)
  return job
}

function fmtReset(resetsAt?: number): string {
  if (!resetsAt) return '?'
  const d = new Date(resetsAt * 1000)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return sameDay ? hm : `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${hm}`
}

function bar(pct: number): string {
  const blocks = 10
  const filled = Math.min(blocks, Math.max(pct > 0 ? 1 : 0, Math.round((pct / 100) * blocks)))
  return '█'.repeat(filled) + '░'.repeat(blocks - filled)
}

/** Resultado interno de cada coletor, antes de virar SeatUsageInfo. */
interface UsageRaw {
  account?: string
  plan?: string
  meters: UsageMeter[]
  lines: string[]
}

// "prolite" → "PRO LITE", "pro_5x" → "PRO 5X" — ids de plano dos provedores
// viram nome apresentável; desconhecido cai no genérico (separadores → espaço).
const PLAN_NAMES: Record<string, string> = {
  prolite: 'PRO LITE',
  promax: 'PRO MAX',
  plus: 'PLUS',
  pro: 'PRO',
  free: 'FREE',
  team: 'TEAM',
  business: 'BUSINESS',
  enterprise: 'ENTERPRISE',
  max: 'MAX'
}

/**
 * Multiplicador do plano do claude (5x / 20x). NÃO vem no handshake — sondado
 * em CLI real: `account` só traz email, organization, subscriptionType e
 * apiProvider. O dado mora no `.claude.json` do config dir do seat, em
 * `oauthAccount.organizationRateLimitTier` ("default_claude_max_20x").
 * Validado nos dois seats do usuário: um 20x e um 5x.
 */
function claudeTier(configDir: string): string | undefined {
  try {
    const raw = readFileSync(join(configDir, '.claude.json'), 'utf8')
    const parsed = JSON.parse(raw) as { oauthAccount?: Record<string, unknown> }
    const acc = parsed.oauthAccount
    if (!acc) return undefined
    // do mais específico para o mais geral: um seat de organização pode ter
    // limite próprio, diferente do limite da org
    for (const key of ['userRateLimitTier', 'seatTier', 'organizationRateLimitTier']) {
      const v = acc[key]
      if (typeof v !== 'string') continue
      const m = /(\d+)x$/i.exec(v)
      if (m) return `${m[1]}x`
    }
  } catch {
    // sem arquivo, sem permissão ou JSON inválido: o plano fica sem o sufixo
  }
  return undefined
}

/**
 * Multiplicador do plano do CODEX. O CLI não tem campo para isso — sondado em
 * três frentes (account/read, account/rateLimits/read e os claims do JWT em
 * auth.json), e o próprio binário só conhece o enum `KnownPlan`
 * (free|go|plus|pro|prolite|team|business|enterprise|edu), sem nenhuma string
 * "5x"/"20x". Mas o PRODUTO tem: o card "ChatGPT Pro" oferece as variantes 5x e
 * 20x, e é a variante que define qual `planType` a conta carrega — `prolite` é
 * a de 5x ("Pro Lite"), `pro` a de 20x (a de US$ 200, "20 vezes mais uso que o
 * Plus"). Mapeamento de PRODUTO, não de campo: se a OpenAI reorganizar os
 * planos, é aqui que envelhece.
 */
const CODEX_TIER: Record<string, string> = {
  prolite: '5x',
  pro: '20x'
}

function prettyPlan(raw?: string): string {
  if (!raw) return ''
  // "Claude Max" → "MAX": o CLI já está identificado no cabeçalho do seat.
  const base = raw.replace(/^claude\s+/i, '')
  const compact = base.toLowerCase().replace(/[\s_-]+/g, '')
  return PLAN_NAMES[compact] ?? base.replace(/[_-]+/g, ' ').trim().toUpperCase()
}

interface RateWindow {
  usedPercent?: number
  windowDurationMins?: number
  resetsAt?: number
}

function codexUsage(configDir: string): Promise<UsageRaw> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server'], {
      env: {
        ...(process.env as Record<string, string>),
        PATH: freshWindowsPath(),
        CODEX_HOME: configDir
      },
      shell: process.platform === 'win32'
    })
    let buf = ''
    let account: { email?: string; planType?: string } | undefined
    let done = false
    const send = (obj: unknown): void => {
      try {
        child.stdin.write(JSON.stringify(obj) + '\n')
      } catch {
        // processo já morreu
      }
    }
    const finish = (fn: () => void): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        child.kill()
      } catch {
        // já morto
      }
      fn()
    }
    const timer = setTimeout(() => finish(() => reject(new Error('timeout'))), 20_000)
    child.on('error', (e) => finish(() => reject(e)))
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        let msg: {
          id?: number
          result?: Record<string, unknown>
          error?: { message?: string }
        }
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.id === 1) {
          send({ jsonrpc: '2.0', method: 'initialized', params: {} })
          send({ jsonrpc: '2.0', id: 2, method: 'account/read', params: {} })
          send({ jsonrpc: '2.0', id: 3, method: 'account/rateLimits/read', params: {} })
        } else if (msg.id === 2) {
          account = msg.result?.['account'] as typeof account
        } else if (msg.id === 3) {
          if (msg.error) {
            finish(() => reject(new Error(msg.error?.message ?? 'rateLimits falhou')))
            return
          }
          interface RateBucket {
            limitName?: string | null
            primary?: RateWindow
            secondary?: RateWindow
            /** repetido em cada bucket — serve de rede quando account/read falha */
            planType?: string | null
            credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string }
          }
          const byId = msg.result?.['rateLimitsByLimitId'] as Record<string, RateBucket> | undefined
          const single = msg.result?.['rateLimits'] as RateBucket | undefined
          const buckets =
            byId && Object.keys(byId).length > 0 ? byId : single ? { codex: single } : {}
          const lines: string[] = []
          const meters: UsageMeter[] = []
          for (const [id, b] of Object.entries(buckets)) {
            // limitName é o nome apresentável do bucket (ex.: "GPT-5.3-Codex-Spark");
            // o bucket agregado do plano vem sem nome (limitId "codex") → "geral".
            const name = b.limitName ?? (id === 'codex' ? 'geral' : id)
            for (const [label, w] of [
              ['', b.primary],
              [' (2ª janela)', b.secondary]
            ] as const) {
              if (!w) continue
              // o TUI do codex conta de 100 a 0 (restante) — espelhar a direção dele
              const used = Math.min(100, Math.max(0, Math.round(w.usedPercent ?? 0)))
              const left = 100 - used
              const dur = w.windowDurationMins
                ? w.windowDurationMins >= 1440
                  ? `${Math.round(w.windowDurationMins / 1440)}d`
                  : `${Math.round(w.windowDurationMins / 60)}h`
                : ''
              meters.push({
                label: `${name}${label}`,
                pct: left,
                mode: 'left',
                severity: used / 100,
                reset: fmtReset(w.resetsAt),
                window: dur || undefined
              })
              lines.push(
                `${name}${label}${dur ? ` · ${dur}` : ''}: ${bar(left)} restam ${left}% · reseta ${fmtReset(w.resetsAt)}`
              )
            }
          }
          // `planType` se repete em cada bucket de rate limit — serve de rede
          // quando o account/read falha, e é dele que sai o 5x/20x.
          const first = Object.values(buckets)[0]
          const planRaw = account?.planType ?? first?.planType ?? undefined
          const cr = first?.credits
          const credit = cr?.unlimited
            ? 'créditos ∞'
            : cr?.hasCredits && cr.balance && cr.balance !== '0'
              ? `créditos ${cr.balance}`
              : undefined
          const tier = planRaw ? CODEX_TIER[planRaw.toLowerCase()] : undefined
          const planName = planRaw
            ? tier
              ? `${prettyPlan(planRaw)} ${tier}`
              : prettyPlan(planRaw)
            : undefined
          finish(() =>
            resolve({
              account: account?.email,
              plan: planName && credit ? `${planName} · ${credit}` : (planName ?? credit),
              meters,
              lines
            })
          )
        }
      }
    })
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'synkora', title: 'Synkora', version: '0.1.0' } }
    })
  })
}

// "Jul 25, 3am (America/Sao_Paulo)" → "25/07 03:00" (hoje → só a hora).
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
}

function fmtClaudeReset(raw: string): string {
  const m = raw.match(/([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i)
  if (!m) return raw.replace(/\s*\([^)]*\)\s*$/, '').trim()
  const mon = MONTHS[m[1].toLowerCase()]
  const day = Number(m[2])
  let h = Number(m[3]) % 12
  if (m[5].toLowerCase() === 'pm') h += 12
  const hm = `${String(h).padStart(2, '0')}:${m[4] ?? '00'}`
  const now = new Date()
  const sameDay = mon !== undefined && now.getDate() === day && now.getMonth() + 1 === mon
  return sameDay ? hm : `${String(day).padStart(2, '0')}/${String(mon ?? 0).padStart(2, '0')} ${hm}`
}

// Texto do /usage do claude → linhas PT-BR com barra, no padrão do codex.
// Ex.: "Current week (all models): 58% used · resets Jul 25, 3am (America/…)"
//   →  "semana (geral): █████░░░░░ 58% usado · reseta 25/07 03:00"
function formatClaudeUsage(
  text: string,
  account: { email?: string; subscriptionType?: string } | undefined,
  tier: string | undefined
): UsageRaw {
  const meters: UsageMeter[] = []
  const lines: string[] = []
  for (const raw of text.split('\n')) {
    const l = raw.replace(/\x1b\[[0-9;]*m/g, '').trim()
    if (!l) continue
    // `· resets …` é OPCIONAL: com 0% usado o CLI omite a data, e a regex
    // antiga (que o exigia) deixava a linha cair no balde de texto cru.
    const m = l.match(/^(.+?):\s*(\d+)%\s*used(?:\s*·\s*resets\s*(.+))?$/i)
    if (!m) {
      lines.push(l)
      continue
    }
    const label = m[1]
      .replace(/^Current session/i, 'sessão')
      .replace(/^Current week/i, 'semana')
      .replace(/^Current month/i, 'mês')
      .replace(/\(all models\)/i, '(geral)')
    const pct = Math.min(100, Math.max(0, Number(m[2])))
    meters.push({
      label,
      pct,
      mode: 'used',
      severity: pct / 100,
      reset: m[3] ? fmtClaudeReset(m[3]) : undefined
    })
    lines.push(
      `${label}: ${bar(pct)} ${pct}% usado${m[3] ? ` · reseta ${fmtClaudeReset(m[3])}` : ''}`
    )
  }
  const plan = account?.subscriptionType ? prettyPlan(account.subscriptionType) : undefined
  return {
    account: account?.email,
    // "MAX" sozinho não diz o que importa na hora de escolher onde delegar —
    // 5x e 20x são contas bem diferentes.
    plan: plan ? (tier ? `${plan} ${tier}` : plan) : tier ? tier.toUpperCase() : undefined,
    meters,
    // O /usage do claude despeja um relatório inteiro em inglês depois dos
    // limites ("What's contributing…", requests, sessões paralelas, top MCP
    // servers). Com medidor reconhecido isso é RUÍDO e é descartado; só quando
    // nada foi parseado o texto cru sobrevive, para não sobrar uma caixa vazia.
    lines: meters.length > 0 ? [] : lines.slice(0, 10)
  }
}

function claudeUsage(configDir: string): Promise<UsageRaw> {
  return new Promise((resolve, reject) => {
    let settled = false
    let account: { email?: string; subscriptionType?: string } | undefined
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      session.kill()
      fn()
    }
    const timer = setTimeout(() => finish(() => reject(new Error('timeout'))), 30_000)
    const session = new MaestroSession({ cwd: homedir(), configDir }, (evt) => {
      switch (evt.type) {
        case 'ready':
          account = evt.caps.account
          break
        case 'command-output':
          finish(() => resolve(formatClaudeUsage(evt.text, account, claudeTier(configDir))))
          break
        case 'result':
          // /usage responde por mensagem assistant SINTÉTICA — o texto vem no
          // result do turno, não em <local-command-stdout> (sondado 2026-07-23).
          if (evt.resultText) {
            const t = evt.resultText
            finish(() => resolve(formatClaudeUsage(t, account, claudeTier(configDir))))
          } else {
            finish(() => reject(new Error(evt.errorText ?? '/usage sem saída')))
          }
          break
        case 'fatal':
          finish(() => reject(new Error(evt.text)))
          break
        default:
          break
      }
    })
    session.personaSent = true // sem persona — é só o /usage
    void session.waitCaps(15_000).then(() => {
      if (!settled) session.send('/usage')
    })
  })
}
