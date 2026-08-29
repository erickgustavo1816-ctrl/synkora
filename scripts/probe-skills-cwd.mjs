// SONDA — de QUAIS pastas POR CWD cada CLI descobre Agent Skills?
//
// Por que existe: Skills 2.0 vai MATERIALIZAR o kit de skills dentro do worktree
// de cada missão. A constante `SKILL_SYNC_TARGETS` (skillsSync.ts) decide em
// que pasta o arquivo é escrito — e escrever na pasta errada é um sync que não
// entrega NADA, em silêncio. A sonda F6 (2026-07-29) provou o claude lendo
// `<config>/skills` e `.claude/skills` do cwd no handshake, e provou que o codex
// tem `skills/list {cwds}` — mas NUNCA registrou QUAL pasta o codex lê por cwd.
// Lei da casa: sondar SEMPRE o binário real antes de afirmar protocolo.
//
// O que ela responde, com FATO (custo: ZERO token nos dois CLIs):
//   P1  claude: quais pastas-candidatas do cwd aparecem no handshake
//       `initialize` (o `commands[]` do control_response) — e com qual sufixo
//       de escopo ("(project)"/"(user)").
//   P2  codex: `skills/list { cwds }` do app-server — quais pastas-candidatas
//       viram entrada, e com qual `scope` (user/repo/system/admin).
//   P3  BOM: um SKILL.md UTF-8 COM BOM some do catálogo / vira `errors[]`?
//       (cada pasta-candidata leva um par: um arquivo limpo e um com BOM).
//   P4  boot: a pasta precisa EXISTIR quando o processo nasce, ou criar depois
//       é enxergado? No claude o roteiro é handshake -> cria -> handshake ->
//       turno -> `/reload-skills` -> handshake -> turno (o handshake sozinho
//       poderia ser retrato do boot; o `system/init` de um turno é o catálogo
//       DAQUELE request, que o claude remonta). No codex, `skills/list` com
//       `forceReload` false e true no MESMO servidor. Controle positivo nos
//       dois: um spawn NOVO no mesmo cwd tem que enxergar.
//   P5  bônus (só codex): `skills/extraRoots/set` monta uma raiz EXTRA fora do
//       cwd — se funcionar, o sync pode APONTAR para a biblioteca em vez de
//       copiar arquivo por worktree.
//   P6  bônus (só codex): das duas pastas que ele lê, uma cria RUÍDO? `.codex/`
//       também é a raiz de config-de-projeto do codex; a sonda isola cada
//       pasta em um app-server só dela e lê o stderr.
//
// Cada raiz é sondada em DUAS variantes, porque o codex tem escopo `repo` e
// "repo" costuma ser resolvido por `.git`:
//   plain/  pasta comum, SEM git
//   git/    a mesma árvore com `git init`
//
// O cwd descartável nasce em `os.tmpdir()` — NUNCA dentro do repo do Synkora,
// NUNCA em projeto do dono — e é apagado no fim (use `--keep` para inspecionar).
//
// PRIVACIDADE: o resumo só publica caminho RELATIVO à raiz da sonda. Skill que
// venha de fora dela (a biblioteca real do dono, `<config>/skills`) é contada
// por escopo e tem o caminho redigido.
//
// MORTE DOS FILHOS: `taskkill /PID <pid> /T /F` — a árvore ENRAIZADA NO NOSSO
// PRÓPRIO PID. Nunca por nome de imagem (a máquina roda Electron e outros
// node que não são nossos — matar por imagem é fratricídio).
//
// Uso:
//   node scripts/probe-skills-cwd.mjs                 # tudo (0 tokens)
//   node scripts/probe-skills-cwd.mjs --only claude
//   node scripts/probe-skills-cwd.mjs --only codex
//   node scripts/probe-skills-cwd.mjs --keep          # não apaga o cwd
//   node scripts/probe-skills-cwd.mjs --timeout 120

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'

const REPO = resolve(process.argv[1], '..', '..')
const OUT_DIR = join(REPO, '.tmp', 'probe-skills-cwd')
const CAPTURE_CLAUDE = join(OUT_DIR, 'claude-frames.jsonl')
const CAPTURE_CODEX = join(OUT_DIR, 'codex-frames.jsonl')
const SUMMARY = join(OUT_DIR, 'summary.json')

const argv = process.argv.slice(2)
const flagValue = (name) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const ONLY = (flagValue('only') || '').split(',').map((s) => s.trim()).filter(Boolean)
const KEEP = argv.includes('--keep')
const TIMEOUT_MS = Number(flagValue('timeout') || 150) * 1000
const wants = (cli) => !ONLY.length || ONLY.includes(cli)

// ---------------------------------------------------------------------------
// As pastas-candidatas. Uma linha aqui = uma coluna na tabela do veredito.
// `.claude/skills` é o CONTROLE POSITIVO do claude (já provado em 2026-07-29):
// se ele sumir, a sonda está quebrada, não o CLI.
// ---------------------------------------------------------------------------
const PREFIX = 'synkprobe'
const CANDIDATES = [
  { slug: 'dotclaude', dir: '.claude/skills' },
  { slug: 'dotcodex', dir: '.codex/skills' },
  { slug: 'dotagents', dir: '.agents/skills' },
  { slug: 'dotagent', dir: '.agent/skills' },
  { slug: 'bare', dir: 'skills' },
  { slug: 'dotgithub', dir: '.github/skills' }
]
const cleanName = (slug) => `${PREFIX}-${slug}`
const bomName = (slug) => `${PREFIX}-bom-${slug}`
const LATE_SLUG = 'late'
const EXTRA_SLUG = 'extraroot'

const BOM = Buffer.from([0xef, 0xbb, 0xbf])

/** SKILL.md mínimo e válido: nome do frontmatter == nome da pasta. */
const skillMarkdown = (name, why) =>
  `---\nname: ${name}\ndescription: Synkora throwaway probe marker (${why}). Never invoke this skill; it does nothing.\n---\n\n# ${name}\n\nSonda descartável do Synkora. Sem conteúdo útil.\n`

/**
 * Escreve `<root>/<dir>/<name>/SKILL.md`. Com BOM, o arquivo sai em BYTES
 * (EF BB BF + UTF-8) e a sonda RE-LÊ os 3 primeiros bytes: alegação de
 * caractere neste projeto se prova por byte, nunca por string.
 */
function writeSkill(root, dir, name, why, withBom) {
  const folder = join(root, ...dir.split('/'), name)
  mkdirSync(folder, { recursive: true })
  const file = join(folder, 'SKILL.md')
  const body = Buffer.from(skillMarkdown(name, why), 'utf8')
  writeFileSync(file, withBom ? Buffer.concat([BOM, body]) : body)
  const head = readFileSync(file).subarray(0, 3)
  const hasBom = head.equals(BOM)
  if (hasBom !== Boolean(withBom)) throw new Error(`BOM esperado=${withBom} em ${file}`)
  return { file, hasBom }
}

// ---------------------------------------------------------------------------
// O workspace descartável
// ---------------------------------------------------------------------------
const WS = join(tmpdir(), 'synkora-probe-skills')
// `late` (claude) e `late-codex` são raízes SEPARADAS de propósito: cada CLI
// precisa da sua nascendo VAZIA, senão a metade que roda depois já encontra a
// pasta criada pela metade anterior e o teste de boot se auto-envenena.
const ROOTS = {
  plain: join(WS, 'plain'),
  git: join(WS, 'git'),
  late: join(WS, 'late'),
  lateCodex: join(WS, 'late-codex'),
  extra: join(WS, 'extra-lib'),
  // P6: cada uma tem UMA das pastas que o codex lê, e nada mais.
  onlyAgents: join(WS, 'only-agents'),
  onlyCodex: join(WS, 'only-codex')
}

function buildWorkspace() {
  rmSync(WS, { recursive: true, force: true })
  const written = []
  for (const key of ['plain', 'git']) {
    const root = ROOTS[key]
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'AGENTS.md'), '# workspace descartável da sonda de skills\n')
    writeFileSync(join(root, 'README.md'), '# workspace descartável da sonda de skills\n')
    for (const c of CANDIDATES) {
      written.push({ root: key, ...c, bom: false, ...writeSkill(root, c.dir, cleanName(c.slug), c.dir, false) })
      written.push({ root: key, ...c, bom: true, ...writeSkill(root, c.dir, bomName(c.slug), `${c.dir} com BOM`, true) })
    }
  }
  // As raízes do teste de boot nascem VAZIAS de propósito (P4) — uma por CLI.
  for (const key of ['late', 'lateCodex']) {
    mkdirSync(ROOTS[key], { recursive: true })
    writeFileSync(join(ROOTS[key], 'AGENTS.md'), '# raiz do teste de boot (nasce sem pasta de skills)\n')
  }
  // A raiz EXTRA vive FORA de qualquer cwd (P5) e imita a biblioteca do
  // Synkora. Duas formas, porque o contrato não diz qual: o skill DIRETO na
  // raiz e o skill sob `raiz/skills/`.
  writeSkill(ROOTS.extra, '.', `${PREFIX}-${EXTRA_SLUG}`, 'raiz extra, skill direto', false)
  writeSkill(ROOTS.extra, 'skills', `${PREFIX}-${EXTRA_SLUG}-nested`, 'raiz extra, sob skills/', false)

  // P6 — uma pasta por raiz, isoladas, para o stderr apontar a culpada.
  writeSkill(ROOTS.onlyAgents, '.agents/skills', `${PREFIX}-only-dotagents`, 'só .agents/skills', false)
  writeSkill(ROOTS.onlyCodex, '.codex/skills', `${PREFIX}-only-dotcodex`, 'só .codex/skills', false)

  const git = spawnSync('git', ['init', '-q'], {
    cwd: ROOTS.git,
    shell: process.platform === 'win32',
    encoding: 'utf8'
  })
  return {
    ws: WS,
    gitInit: { status: git.status, stderr: (git.stderr || '').trim().slice(0, 200) },
    files: written.length,
    bomFiles: written.filter((w) => w.hasBom).length
  }
}

/** Cria, DEPOIS do processo nascer, um skill em cada pasta-candidata (P4). */
function lateCreate(root) {
  const made = []
  for (const c of CANDIDATES) {
    writeSkill(root, c.dir, `${PREFIX}-${LATE_SLUG}-${c.slug}`, `criado após o boot em ${c.dir}`, false)
    made.push(`${c.dir}/${PREFIX}-${LATE_SLUG}-${c.slug}`)
  }
  return made
}

// ---------------------------------------------------------------------------
// Higiene do ambiente do filho (idêntica ao maestroSession/pty) + morte por PID
// ---------------------------------------------------------------------------
function childEnv() {
  const env = { ...process.env }
  for (const k of Object.keys(env)) {
    if (/^CLAUDE_CODE_/i.test(k) && k !== 'CLAUDE_CONFIG_DIR') delete env[k]
  }
  delete env.CLAUDECODE
  delete env.NO_COLOR
  delete env.FORCE_COLOR
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  return env
}

/**
 * Mata a árvore ENRAIZADA no pid do NOSSO filho. No Windows o spawn passa por
 * shell (`.cmd` não roda sem ele), então matar só o shell deixaria o CLI órfão
 * — daí o `/T`. Nunca `taskkill /IM`: por imagem mataria Electron/node do dono.
 */
function hardKill(child) {
  if (!child || !child.pid) return
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {}
  }
  try {
    child.kill()
  } catch {}
}

// ---------------------------------------------------------------------------
// Leitura das evidências: só o que é NOSSO vira caminho; o resto é contado.
// ---------------------------------------------------------------------------
const rootsByName = () => Object.entries(ROOTS).map(([k, v]) => [k, resolve(v)])

/** Classifica um caminho absoluto de skill: dentro de qual raiz da sonda? */
function locate(absPath) {
  if (typeof absPath !== 'string') return { inside: null, rel: null }
  const abs = resolve(absPath)
  for (const [name, root] of rootsByName()) {
    const rel = relative(root, abs)
    if (rel && !rel.startsWith('..') && !rel.includes(`..${sep}`)) {
      return { inside: name, rel: rel.split(sep).join('/') }
    }
  }
  return { inside: null, rel: null }
}

/** `.claude/skills/synkprobe-bare/SKILL.md` -> `.claude/skills` */
const dirOfRel = (rel) => (rel || '').split('/').slice(0, -2).join('/') || '.'

// ---------------------------------------------------------------------------
// P1/P3/P4 — claude: o handshake `initialize` (control_request local, 0 token)
//
// O roteiro do cenário `late` é o ÚNICO gasto de token da sonda: dois turnos
// mínimos em haiku. Eles existem porque o claude monta catálogo POR REQUEST —
// um handshake sozinho poderia ser retrato cacheado do boot e mentiria.
//
//   handshake  o control_request local `initialize` -> `commands[]`
//   create     cria as pastas AGORA (o processo já nasceu) e espera 6s
//   turn       um turno haiku -> `system/init.slash_commands` daquele request
//   slash      `/reload-skills` como mensagem de usuário (a RECEITA candidata)
// ---------------------------------------------------------------------------
const TURN_PROMPT = 'responda apenas: ok'
const SIMPLE_STEPS = [{ kind: 'handshake', why: 'catálogo do boot' }]
const LATE_STEPS = [
  { kind: 'handshake', why: 'antes — a pasta não existe' },
  { kind: 'create', why: 'cria a pasta com o processo JÁ de pé' },
  { kind: 'handshake', why: 'depois de criar — tem watcher?' },
  { kind: 'turn', text: TURN_PROMPT, why: 'catálogo por request re-varre?' },
  { kind: 'slash', text: '/reload-skills', why: 'a receita: recarregar em vida' },
  { kind: 'handshake', why: 'depois do /reload-skills' },
  { kind: 'turn', text: TURN_PROMPT, why: 'catálogo por request após o reload' }
]

function runClaude(label, cwd, { lateAfterHandshake = false } = {}) {
  return new Promise((done) => {
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'haiku'
    ]
    const steps = lateAfterHandshake ? LATE_STEPS : SIMPLE_STEPS
    const out = {
      label,
      cwd: label,
      spawnArgs: args,
      steps: [],
      lateCreated: null,
      stderr: [],
      error: null,
      stopReason: null
    }

    const child = spawn('claude', args, {
      cwd,
      env: childEnv(),
      shell: process.platform === 'win32'
    })

    let buf = ''
    let finished = false
    let cursor = -1
    let current = null
    const REQ = (n) => `probe-skills-init-${n}`

    const send = (obj) => {
      try {
        child.stdin.write(JSON.stringify(obj) + '\n')
      } catch (e) {
        out.error = `stdin: ${e.message}`
      }
    }

    const finish = (reason) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      out.stopReason = reason
      try {
        child.stdin.end()
      } catch {}
      hardKill(child)
      setTimeout(() => done(out), 250)
    }
    const timer = setTimeout(() => finish('timeout'), TIMEOUT_MS)

    child.stdout.on('data', (d) => {
      buf += d.toString('utf8')
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.trim()) handleLine(line)
      }
    })
    child.stderr.on('data', (d) => {
      const s = d.toString('utf8').trim()
      if (s) out.stderr.push(s.slice(0, 400))
    })
    child.on('error', (e) => {
      out.error = `spawn falhou: ${e.message}`
      finish('erro de spawn')
    })
    child.on('close', (code) => finish(`o CLI encerrou (exit ${code})`))

    const probeOf = (commands) =>
      (commands ?? [])
        .filter((c) => typeof (c?.name ?? c) === 'string' && String(c?.name ?? c).startsWith(PREFIX))
        .map((c) =>
          typeof c === 'string'
            ? { name: c, description: '' }
            : { name: c.name, description: String(c.description ?? '').slice(0, 200) }
        )
        .sort((a, b) => a.name.localeCompare(b.name))

    /** Avança o roteiro. `create` não fala com o CLI: mexe no disco e espera. */
    function nextStep() {
      cursor += 1
      if (cursor >= steps.length) return finish('roteiro concluído')
      const step = steps[cursor]
      current = {
        index: cursor,
        kind: step.kind,
        why: step.why,
        sent: step.text ?? null,
        total: null,
        probeCommands: [],
        resultText: null
      }
      out.steps.push(current)
      process.stderr.write(`  [${label}] passo ${cursor} (${step.kind}) — ${step.why}\n`)

      if (step.kind === 'create') {
        out.lateCreated = lateCreate(cwd)
        current.total = out.lateCreated.length
        // Janela generosa: se houvesse watcher, 6s bastariam para ele reagir.
        setTimeout(nextStep, 6000)
        return
      }
      if (step.kind === 'handshake') {
        send({ type: 'control_request', request_id: REQ(cursor), request: { subtype: 'initialize' } })
        return
      }
      // turn e slash entram pelo MESMO canal: mensagem de usuário.
      send({ type: 'user', message: { role: 'user', content: step.text } })
    }

    function handleLine(line) {
      appendFileSync(CAPTURE_CLAUDE, `${label} ${line}\n`)
      let evt
      try {
        evt = JSON.parse(line)
      } catch {
        return
      }

      // o CLI pede permissão de tool — a sonda nega (nenhum passo usa tool)
      if (evt.type === 'control_request' && evt.request?.subtype === 'can_use_tool') {
        send({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: evt.request_id,
            response: { behavior: 'deny', message: 'sonda: sem tools' }
          }
        })
        return
      }

      if (!current) return

      // handshake: o `commands[]` do control_response daquele request_id
      if (current.kind === 'handshake') {
        if (evt.type !== 'control_response' || evt.response?.request_id !== REQ(cursor)) return
        const commands = evt.response?.response?.commands ?? []
        current.total = commands.length
        current.probeCommands = probeOf(commands)
        return nextStep()
      }

      // turn/slash: o `system/init` do request traz o catálogo DAQUELE request
      if ((current.kind === 'turn' || current.kind === 'slash') && evt.type === 'system' && evt.subtype === 'init') {
        const cmds = evt.slash_commands ?? evt.slashCommands ?? evt.commands ?? []
        current.model = evt.model
        current.total = Array.isArray(cmds) ? cmds.length : null
        current.probeCommands = probeOf(cmds)
        return
      }
      if ((current.kind === 'turn' || current.kind === 'slash') && evt.type === 'result') {
        current.resultText = typeof evt.result === 'string' ? evt.result.slice(0, 300) : null
        current.isError = evt.is_error ?? null
        current.costUsd = evt.total_cost_usd ?? null
        return nextStep()
      }
    }

    nextStep()
  })
}

// ---------------------------------------------------------------------------
// P2/P3/P4/P5 — codex: app-server JSON-RPC sobre stdio
// ---------------------------------------------------------------------------
function runCodex() {
  return new Promise((done) => {
    const out = {
      lists: {},
      lateCreated: null,
      extraRoots: null,
      stderr: [],
      error: null,
      stopReason: null
    }
    const child = spawn('codex', ['app-server'], {
      cwd: ROOTS.plain,
      env: childEnv(),
      shell: process.platform === 'win32'
    })

    let buf = ''
    let nextId = 1
    let finished = false
    const pending = new Map()

    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n')
    const request = (method, params) =>
      new Promise((res) => {
        const id = nextId++
        pending.set(id, res)
        send({ jsonrpc: '2.0', id, method, params })
      })
    const notify = (method, params) => send({ jsonrpc: '2.0', method, params })

    const finish = (reason) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      out.stopReason = reason
      hardKill(child) // o app-server NUNCA morre sozinho
      setTimeout(() => done(out), 250)
    }
    const timer = setTimeout(() => finish('timeout'), TIMEOUT_MS)

    child.stdout.on('data', (d) => {
      buf += d.toString('utf8')
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        appendFileSync(CAPTURE_CODEX, line + '\n')
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.id !== undefined && msg.method === undefined) {
          const res = pending.get(msg.id)
          if (res) {
            pending.delete(msg.id)
            res(msg)
          }
          continue
        }
        // pedido do servidor (aprovação): a sonda não roda turno nem tool
        if (msg.id !== undefined && msg.method) send({ jsonrpc: '2.0', id: msg.id, result: { decision: 'denied' } })
      }
    })
    child.stderr.on('data', (d) => {
      const s = d.toString('utf8').trim()
      if (s) out.stderr.push(s.slice(0, 400))
    })
    child.on('error', (e) => {
      out.error = `spawn falhou: ${e.message}`
      finish('erro de spawn')
    })

    /** Reduz uma SkillsListResponse ao que é evidência (e nada do dono). */
    const digest = (rsp) => {
      if (rsp?.error) return { error: rsp.error }
      const data = rsp?.result?.data ?? []
      return data.map((entry) => {
        const here = []
        const outsideByScope = {}
        for (const s of entry.skills ?? []) {
          const { inside, rel } = locate(s.path)
          if (inside) here.push({ name: s.name, scope: s.scope, enabled: s.enabled, dir: dirOfRel(rel), rel })
          else outsideByScope[s.scope ?? '?'] = (outsideByScope[s.scope ?? '?'] || 0) + 1
        }
        const errors = (entry.errors ?? []).map((e) => {
          const { inside, rel } = locate(e.path)
          return { path: inside ? `${inside}/${rel}` : '«fora da sonda»', message: String(e.message ?? '').slice(0, 300) }
        })
        const { inside } = locate(entry.cwd)
        return {
          cwd: inside ?? '«fora da sonda»',
          probeSkills: here.sort((a, b) => a.name.localeCompare(b.name)),
          outsideByScope,
          errors
        }
      })
    }

    ;(async () => {
      const init = await request('initialize', {
        clientInfo: { name: 'synkora-probe-skills', title: 'Synkora skills-cwd probe', version: '0.0.1' }
      })
      if (init?.error) {
        out.error = `initialize: ${JSON.stringify(init.error).slice(0, 300)}`
        return finish('initialize falhou')
      }
      notify('initialized', {})

      // P2/P3 — as duas raízes de uma vez (o método aceita `cwds`).
      out.lists.roots = digest(
        await request('skills/list', { cwds: [ROOTS.plain, ROOTS.git], forceReload: true })
      )

      // P4 — a raiz `late-codex` nasceu vazia; o servidor JÁ está de pé.
      out.lists.lateBefore = digest(await request('skills/list', { cwds: [ROOTS.lateCodex], forceReload: true }))
      out.lateCreated = lateCreate(ROOTS.lateCodex)
      out.lists.lateCached = digest(await request('skills/list', { cwds: [ROOTS.lateCodex], forceReload: false }))
      out.lists.lateForced = digest(await request('skills/list', { cwds: [ROOTS.lateCodex], forceReload: true }))

      // P5 — raiz EXTRA fora do cwd (o sync poderia APONTAR em vez de copiar).
      const setRoots = await request('skills/extraRoots/set', { extraRoots: [ROOTS.extra] })
      out.extraRoots = { ok: !setRoots?.error, error: setRoots?.error ?? null }
      out.lists.withExtraRoot = digest(await request('skills/list', { cwds: [ROOTS.plain], forceReload: true }))

      finish('concluído')
    })().catch((e) => {
      out.error = `fatal: ${e?.message}`
      finish('fatal')
    })
  })
}

/**
 * P6 — um app-server SÓ para esta raiz, um `skills/list`, e o stderr que ele
 * cuspiu. É assim que se sabe QUAL pasta gera o aviso de projeto não confiável.
 */
function runCodexTrustNoise(label, cwd) {
  return new Promise((done) => {
    const out = { label, skills: [], stderr: [], error: null }
    const child = spawn('codex', ['app-server'], {
      cwd,
      env: childEnv(),
      shell: process.platform === 'win32'
    })
    let buf = ''
    let finished = false
    const pending = new Map()
    let nextId = 1
    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n')
    const request = (method, params) =>
      new Promise((res) => {
        const id = nextId++
        pending.set(id, res)
        send({ jsonrpc: '2.0', id, method, params })
      })
    const finish = (reason) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      out.stopReason = reason
      hardKill(child)
      setTimeout(() => done(out), 250)
    }
    const timer = setTimeout(() => finish('timeout'), TIMEOUT_MS)
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8')
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        appendFileSync(CAPTURE_CODEX, line + '\n')
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.id !== undefined && msg.method === undefined) {
          const res = pending.get(msg.id)
          if (res) {
            pending.delete(msg.id)
            res(msg)
          }
        }
      }
    })
    child.stderr.on('data', (d) => {
      // O aviso vem em várias linhas com cor ANSI; a sonda tira a cor e junta.
      const s = d.toString('utf8').replace(/\[[0-9;]*m/g, '').trim()
      if (s) out.stderr.push(s.slice(0, 500))
    })
    child.on('error', (e) => {
      out.error = `spawn falhou: ${e.message}`
      finish('erro de spawn')
    })
    ;(async () => {
      const init = await request('initialize', {
        clientInfo: { name: 'synkora-probe-skills', title: 'Synkora skills-cwd probe', version: '0.0.1' }
      })
      if (init?.error) {
        out.error = `initialize: ${JSON.stringify(init.error).slice(0, 200)}`
        return finish('initialize falhou')
      }
      send({ jsonrpc: '2.0', method: 'initialized', params: {} })
      const rsp = await request('skills/list', { cwds: [cwd], forceReload: true })
      for (const entry of rsp?.result?.data ?? []) {
        for (const s of entry.skills ?? []) {
          const { inside, rel } = locate(s.path)
          if (inside) out.skills.push({ name: s.name, scope: s.scope, dir: dirOfRel(rel) })
        }
      }
      // dá um respiro para o stderr atrasado chegar antes do kill
      setTimeout(() => finish('concluído'), 1200)
    })().catch((e) => {
      out.error = `fatal: ${e?.message}`
      finish('fatal')
    })
  })
}

// ---------------------------------------------------------------------------
;(async () => {
  mkdirSync(OUT_DIR, { recursive: true })
  // Só zera a captura da metade que VAI rodar: `--only codex` não pode apagar
  // a evidência crua do claude (o resumo já é cumulativo pelo mesmo motivo).
  if (wants('claude')) writeFileSync(CAPTURE_CLAUDE, '')
  if (wants('codex')) writeFileSync(CAPTURE_CODEX, '')

  const report = {
    probedAt: new Date().toISOString(),
    versions: {
      claude: spawnSync('claude', ['--version'], { shell: true, encoding: 'utf8' }).stdout?.trim(),
      codex: spawnSync('codex', ['--version'], { shell: true, encoding: 'utf8' }).stdout?.trim()
    },
    candidates: CANDIDATES.map((c) => c.dir),
    workspace: null,
    claude: null,
    codex: null,
    verdict: null
  }

  report.workspace = buildWorkspace()
  console.log(`workspace: ${WS}`)
  console.log(`  ${report.workspace.files} SKILL.md (${report.workspace.bomFiles} com BOM) · git init status=${report.workspace.gitInit.status}`)

  if (wants('claude')) {
    console.log('\n=== claude — handshake initialize (0 tokens) ===')
    const plain = await runClaude('plain', ROOTS.plain)
    const git = await runClaude('git', ROOTS.git)
    const late = await runClaude('late', ROOTS.late, { lateAfterHandshake: true })
    // CONTROLE POSITIVO: as MESMAS pastas, agora presentes no boot de um
    // processo NOVO. Se aqui também não aparecer, o negativo acima era da
    // sonda (arquivo inválido), não do CLI.
    const lateFresh = await runClaude('late-fresh', ROOTS.late)
    report.claude = { plain, git, late, lateFresh }
    for (const run of [plain, git, late, lateFresh]) {
      console.log(`  [${run.label}] ${run.stopReason}`)
      for (const st of run.steps) {
        const head = `    ${String(st.index).padStart(2)} ${st.kind.padEnd(9)} ${String(st.total ?? '-').padStart(3)} · sonda: ${st.probeCommands.length}`
        console.log(`${head}   (${st.why})`)
        for (const c of st.probeCommands) console.log(`        ${c.name}  —  ${c.description}`)
        if (st.resultText) console.log(`        resultado: ${st.resultText.replace(/\s+/g, ' ').slice(0, 160)}`)
      }
      if (run.error) console.log(`    ERRO: ${run.error}`)
      for (const s of run.stderr.slice(0, 4)) console.log(`    [stderr] ${s}`)
    }
  }

  if (wants('codex')) {
    console.log('\n=== codex — app-server skills/list (0 tokens) ===')
    report.codex = await runCodex()
    for (const [name, entries] of Object.entries(report.codex.lists)) {
      console.log(`  --- ${name} ---`)
      if (!Array.isArray(entries)) {
        console.log(`    ${JSON.stringify(entries).slice(0, 300)}`)
        continue
      }
      for (const e of entries) {
        console.log(`    cwd=${e.cwd} · sonda=${e.probeSkills.length} · fora=${JSON.stringify(e.outsideByScope)}`)
        for (const s of e.probeSkills) console.log(`      ${s.name}  scope=${s.scope}  dir=${s.dir}`)
        for (const err of e.errors) console.log(`      [erro] ${err.path} :: ${err.message}`)
      }
    }
    console.log(`  extraRoots/set: ${JSON.stringify(report.codex.extraRoots)}`)
    if (report.codex.error) console.log(`  ERRO: ${report.codex.error}`)
    for (const s of report.codex.stderr.slice(0, 4)) console.log(`  [stderr] ${s}`)

    console.log('\n=== codex — P6: qual pasta faz barulho de "projeto não confiável" ===')
    report.codex.trustNoise = [
      await runCodexTrustNoise('only-agents', ROOTS.onlyAgents),
      await runCodexTrustNoise('only-codex', ROOTS.onlyCodex)
    ]
    for (const r of report.codex.trustNoise) {
      const noisy = r.stderr.filter((s) => /trusted/i.test(s))
      console.log(`  [${r.label}] skills=${r.skills.map((s) => `${s.name}@${s.dir}`).join(', ') || '(nenhum)'} · avisos de trust=${noisy.length}`)
      for (const s of noisy) console.log(`    ${s.split('\n').join(' | ')}`)
    }
  }

  // O resumo é CUMULATIVO: rodar só uma metade (`--only codex`) não apaga a
  // evidência da outra — a sonda é barata, mas re-rodar por bobagem não é.
  let previous = null
  try {
    previous = JSON.parse(readFileSync(SUMMARY, 'utf8'))
  } catch {}
  if (!report.claude && previous?.claude) report.claude = previous.claude
  if (!report.codex && previous?.codex) report.codex = previous.codex

  // ————— veredito mecânico: pasta x CLI —————
  /** o PRIMEIRO handshake de uma execução = o catálogo do BOOT daquele cwd */
  const bootCommands = (run) => run?.steps?.find((s) => s.kind === 'handshake')?.probeCommands ?? []
  const stepProbe = (run, i) => run?.steps?.[i]?.probeCommands ?? []
  const claudeSeen = new Set()
  for (const run of Object.values(report.claude ?? {})) {
    for (const c of bootCommands(run)) claudeSeen.add(c.name)
  }
  const codexSeen = new Set()
  const codexErrors = []
  for (const entries of Object.values(report.codex?.lists ?? {})) {
    if (!Array.isArray(entries)) continue
    for (const e of entries) {
      for (const s of e.probeSkills) codexSeen.add(s.name)
      codexErrors.push(...e.errors)
    }
  }
  const claudeDesc = new Map()
  for (const run of [report.claude?.plain, report.claude?.git]) {
    for (const c of bootCommands(run)) claudeDesc.set(c.name, c.description)
  }
  const table = CANDIDATES.map((c) => ({
    folder: c.dir,
    claude: claudeSeen.has(cleanName(c.slug)),
    codex: codexSeen.has(cleanName(c.slug))
  }))
  const bomTable = CANDIDATES.map((c) => ({
    folder: c.dir,
    claudeBomListed: claudeSeen.has(bomName(c.slug)),
    // A prova forte não é "apareceu": é o CLI ter LIDO o frontmatter do
    // arquivo com BOM (a description só existe lá dentro).
    claudeBomFrontmatterParsed: (claudeDesc.get(bomName(c.slug)) ?? '').includes(`(${c.dir} com BOM)`),
    codexBomListed: codexSeen.has(bomName(c.slug))
  }))
  const lateRun = report.claude?.late
  const lateFreshSees = bootCommands(report.claude?.lateFresh).some((c) =>
    c.name.startsWith(`${PREFIX}-${LATE_SLUG}-`)
  )
  // Índices do LATE_STEPS: 2 = handshake após criar · 3 = turno ·
  // 4 = /reload-skills · 5 = handshake após o reload · 6 = turno após o reload
  const seenAfterCreate = stepProbe(lateRun, 2).length > 0 || stepProbe(lateRun, 3).length > 0
  const seenAfterReload = stepProbe(lateRun, 5).length > 0 || stepProbe(lateRun, 6).length > 0
  report.verdict = {
    table,
    bomTable,
    codexErrors,
    claudeLateSeenAfterCreate: {
      handshake: stepProbe(lateRun, 2).length > 0,
      turn: stepProbe(lateRun, 3).length > 0
    },
    claudeReloadSkills: {
      sent: lateRun?.steps?.[4]?.sent ?? null,
      isError: lateRun?.steps?.[4]?.isError ?? null,
      resultText: lateRun?.steps?.[4]?.resultText ?? null,
      handshakeAfter: stepProbe(lateRun, 5).length > 0,
      turnAfter: stepProbe(lateRun, 6).length > 0
    },
    claudeLateFreshSpawnSees: lateFreshSees,
    // Só é "pasta obrigatória no boot" se o CONTROLE POSITIVO enxergou: o
    // negativo isolado poderia ser arquivo inválido, não regra do CLI.
    claudeBootFolderRequired:
      lateRun && lateFreshSees ? !seenAfterCreate && !seenAfterReload : '(controle positivo não confirmou — inconclusivo)',
    codexSeesLateCreate: {
      cached: (report.codex?.lists?.lateCached ?? []).some((e) => e.probeSkills.length > 0),
      forced: (report.codex?.lists?.lateForced ?? []).some((e) => e.probeSkills.length > 0)
    },
    codexExtraRootWorks: (report.codex?.lists?.withExtraRoot ?? []).some((e) =>
      e.probeSkills.some((s) => s.name.startsWith(`${PREFIX}-${EXTRA_SLUG}`))
    ),
    codexTrustNoise: (report.codex?.trustNoise ?? []).map((r) => ({
      root: r.label,
      skillsFound: r.skills.length,
      trustWarnings: r.stderr.filter((s) => /trusted/i.test(s)).length
    })),
    syncTargets: {
      claude: table.filter((t) => t.claude).map((t) => t.folder),
      codex: table.filter((t) => t.codex).map((t) => t.folder)
    }
  }

  writeFileSync(SUMMARY, JSON.stringify(report, null, 2))
  console.log('\n=== VEREDITO (pasta x CLI) ===')
  for (const row of table) console.log(`  ${row.folder.padEnd(16)} claude=${row.claude ? 'SIM' : 'não'}  codex=${row.codex ? 'SIM' : 'não'}`)
  console.log('\n=== VEREDITO (BOM no SKILL.md) ===')
  for (const row of bomTable.filter((r) => table.find((t) => t.folder === r.folder)?.claude || table.find((t) => t.folder === r.folder)?.codex))
    console.log(
      `  ${row.folder.padEnd(16)} claude: listado=${row.claudeBomListed ? 'SIM' : 'não'} frontmatter-lido=${row.claudeBomFrontmatterParsed ? 'SIM' : 'não'}  ·  codex: listado=${row.codexBomListed ? 'SIM' : 'não'}`
    )
  for (const e of codexErrors) console.log(`  [codex errors] ${e.path} :: ${e.message}`)
  console.log('\n=== VEREDITO (pasta criada DEPOIS do boot) ===')
  console.log(`  claude · após criar: handshake viu=${report.verdict.claudeLateSeenAfterCreate.handshake} · turno viu=${report.verdict.claudeLateSeenAfterCreate.turn}`)
  console.log(`  claude · /reload-skills: erro=${report.verdict.claudeReloadSkills.isError} · handshake depois viu=${report.verdict.claudeReloadSkills.handshakeAfter} · turno depois viu=${report.verdict.claudeReloadSkills.turnAfter}`)
  if (report.verdict.claudeReloadSkills.resultText)
    console.log(`             resposta: ${String(report.verdict.claudeReloadSkills.resultText).replace(/\s+/g, ' ').slice(0, 200)}`)
  console.log(`  claude · spawn NOVO no mesmo cwd viu=${report.verdict.claudeLateFreshSpawnSees}`)
  console.log(`  claude · pasta exigida no boot: ${report.verdict.claudeBootFolderRequired}`)
  console.log(`  codex  · ${JSON.stringify(report.verdict.codexSeesLateCreate)} · extraRoots funciona=${report.verdict.codexExtraRootWorks}`)
  console.log(`\nSKILL_SYNC_TARGETS sugerido: ${JSON.stringify(report.verdict.syncTargets)}`)
  console.log(`resumo: ${SUMMARY}`)

  if (KEEP) console.log(`\nworkspace preservado (--keep): ${WS}`)
  else {
    rmSync(WS, { recursive: true, force: true })
    console.log(`\nworkspace descartável apagado: ${existsSync(WS) ? 'FALHOU' : 'ok'}`)
  }
  process.exit(0)
})()
