import { useState } from 'react'
import { useStore, type Department } from '../store'
import { DEPARTMENTS, deptHueVar } from '../departments'
import type { SkillState } from '../../../preload/index'

// ————————————————————————————————————————————————————————————————————————
// Seção de Configurações: a BIBLIOTECA de skills (global à máquina — vale para todos
// os universos). NAVEGAÇÃO POR FUNÇÃO (decisão do usuário, 2026-07-29:
// "vai ter 300 skills, divide por card de front/back"): um card por função
// no topo, o painel mostra SÓ as skills da função selecionada, agrupadas
// por ocasião — nunca uma rolagem única. Função sem rodada ainda = card
// "em breve". Nasce RECOLHIDA (só o header com resumo). Instalar/atualizar/
// remover moram AQUI; a ★ padrão por projeto mora na página ✦ geral.
// "+ adicionar skill" instala qualquer skill de um repo GitHub na função
// selecionada (o nome/descrição saem do SKILL.md real).
// ————————————————————————————————————————————————————————————————————————

// Seções SEPARADAS em Configurações (decisão do usuário, 2026-07-29: "subagente não
// mora dentro da biblioteca de skills"): uma instância por kind, cada uma
// com contagem, colapso e ações próprias.
interface Props {
  kind: 'skill' | 'agent'
  /** Na página dedicada, a biblioteca nasce aberta na primeira visita. */
  openByDefault?: boolean
}

export default function SkillsLibrary({ kind, openByDefault = false }: Props): React.JSX.Element {
  const isAgent = kind === 'agent'
  const openKey = isAgent ? 'synkora.agentsLibOpen' : 'synkora.skillsLibOpen'
  const skillsLib = useStore((s) => s.skillsLib)
  const settings = useStore((s) => s.settings)
  const setSettingsSecret = useStore((s) => s.setSettingsSecret)
  const [busy, setBusy] = useState<string | null>(null)
  const [busyAll, setBusyAll] = useState(false)
  const [err, setErr] = useState('')
  const [checking, setChecking] = useState(false)
  const [dept, setDept] = useState<Department>('front')
  const [showAdd, setShowAdd] = useState(false)
  const [addUrl, setAddUrl] = useState('')
  const [adding, setAdding] = useState(false)
  const [ioBusy, setIoBusy] = useState(false)
  const [ioMsg, setIoMsg] = useState('')
  // Nasce recolhida fora da central; em Configurações, openByDefault a abre.
  const [open, setOpen] = useState(() => {
    const saved = localStorage.getItem(openKey)
    return saved === null ? openByDefault : saved === '1'
  })
  const toggle = (): void =>
    setOpen((v) => {
      localStorage.setItem(openKey, v ? '0' : '1')
      return !v
    })

  const skills = skillsLib.filter((sk) => sk.kind === kind)
  const installed = skills.filter((sk) => sk.installed).length
  const updates = skills.filter((sk) => sk.updateAvailable).length
  const ofDept = (d: Department): SkillState[] => skills.filter((sk) => sk.depts.includes(d))
  const shown = ofDept(dept)
  const notInstalled = shown.filter((sk) => !sk.installed)

  // Grupos por ocasião, na ordem do catálogo.
  const groups: { name: string; items: SkillState[] }[] = []
  for (const sk of shown) {
    let g = groups.find((x) => x.name === sk.group)
    if (!g) {
      g = { name: sk.group, items: [] }
      groups.push(g)
    }
    g.items.push(sk)
  }

  const run = async (op: 'install' | 'update' | 'remove', id: string): Promise<void> => {
    setBusy(id)
    setErr('')
    const r = await window.synkora.skills[op](id)
    if (!r.ok) setErr(r.msg)
    setBusy(null)
  }

  const installAll = async (): Promise<void> => {
    setBusyAll(true)
    setErr('')
    const r = await window.synkora.skills.installMany(notInstalled.map((sk) => sk.id))
    if (!r.ok) setErr(r.msg)
    setBusyAll(false)
  }

  // "⭳ instalar tudo": TODA a curadoria não-instalada — as 8 funções, skills
  // E subagentes de uma vez (o export/import também é sempre global; isto
  // fecha o ciclo). RETOMÁVEL: só os não-instalados entram, então se a cota
  // do GitHub estourar no meio, o que baixou fica e um novo clique continua.
  const allPend = skillsLib.filter((sk) => !sk.installed)
  const installEverything = async (): Promise<void> => {
    setBusyAll(true)
    setErr('')
    setIoMsg('')
    const r = await window.synkora.skills.installMany(allPend.map((sk) => sk.id))
    if (r.ok) setIoMsg(r.msg)
    else setErr(r.msg)
    setBusyAll(false)
  }

  // token opcional do GitHub (60/h → 5.000/h); o valor NUNCA é exibido —
  // o campo abre vazio e só grava o que for digitado agora (padrão da casa).
  const [showToken, setShowToken] = useState(false)
  const [tokenDraft, setTokenDraft] = useState('')
  const saveToken = async (): Promise<void> => {
    const v = tokenDraft.trim()
    if (!v) return
    try {
      await setSettingsSecret('githubToken', v)
    } catch {
      setErr('não foi possível proteger o token agora — tente novamente')
      return
    }
    setTokenDraft('')
    setShowToken(false)
    setIoMsg('token salvo — cota de instalação agora é 5.000/h')
  }
  const clearToken = async (): Promise<void> => {
    try {
      await setSettingsSecret('githubToken')
    } catch {
      setErr('não foi possível remover o token agora — tente novamente')
      return
    }
    setTokenDraft('')
    setIoMsg('token removido — cota volta à anônima (60/h)')
  }

  const addCustom = async (): Promise<void> => {
    if (!addUrl.trim() || adding) return
    setAdding(true)
    setErr('')
    const r = isAgent
      ? await window.synkora.skills.addCustomAgent(addUrl.trim(), dept)
      : await window.synkora.skills.addCustom(addUrl.trim(), dept)
    if (r.ok) {
      setAddUrl('')
      setShowAdd(false)
    } else {
      setErr(r.msg)
    }
    setAdding(false)
  }

  // export/import da biblioteca INTEIRA (portabilidade entre PCs): o .zip
  // carrega skills + subagentes + customs + pins de versão; importar é
  // 100% offline. msg vazia = usuário cancelou o dialog (não é erro).
  const runIo = async (op: 'exportLib' | 'importLib'): Promise<void> => {
    setIoBusy(true)
    setErr('')
    setIoMsg('')
    const r = await window.synkora.skills[op]()
    if (r.ok) setIoMsg(r.msg)
    else if (r.msg) setErr(r.msg)
    setIoBusy(false)
  }

  const check = async (): Promise<void> => {
    setChecking(true)
    try {
      await window.synkora.skills.check()
    } finally {
      setChecking(false)
    }
  }

  return (
    <section className={`skills-lib${open ? ' open' : ''}`}>
      <div className="section-label skills-lib-head">
        <button
          className="skills-lib-toggle"
          onClick={toggle}
          data-tip={
            open
              ? undefined
              : isAgent
                ? 'abrir a biblioteca (instalar/atualizar subagentes)'
                : 'abrir a biblioteca (instalar/atualizar skills)'
          }
        >
          <span className="func-caret">{open ? '▾' : '▸'}</span>{' '}
          {isAgent ? 'subagentes especializados' : 'biblioteca de skills'}
          <span className="skills-lib-count">
            {installed}/{skills.length} instalad{isAgent ? 'os' : 'as'}
          </span>
        </button>
        <span className="skills-lib-meta">
          {updates > 0 && (
            <span className="func-badge warn" data-tip="skills instaladas com versão nova na fonte">
              ⟳ {updates} atualização{updates > 1 ? 'ões' : ''}
            </span>
          )}
          <button
            className="btn ghost tiny"
            disabled={checking}
            data-tip={'confere as fontes das skills instaladas agora\n(sozinho, isso roda 1× por dia ao abrir o app)'}
            onClick={() => void check()}
          >
            {checking ? 'conferindo…' : '⟳ conferir'}
          </button>
        </span>
      </div>
      {open && (
        <>
          <p className="skills-lib-note">
            {isAgent ? (
              <>
                Especialistas com persona própria — vale para <b>todos os universos</b>. O
                orquestrador aconselha o especialista por ajudante (delegate.agent) e carimba por
                card; executor claude também os invoca direto (Task tool). ★ padrão por função na
                página ✦ geral.
              </>
            ) : (
              <>
                Curadoria instalada da fonte com versão pinada — vale para <b>todos os universos</b>
                . Quem escolhe a skill de cada card/ajudante é o orquestrador; o ★ padrão por função
                fica na página ✦ geral de cada universo.
              </>
            )}
          </p>
          <div className="lib-dept-row">
            {DEPARTMENTS.map((d) => {
              const list = ofDept(d.key)
              const inst = list.filter((sk) => sk.installed).length
              const upd = list.some((sk) => sk.installed && sk.updateAvailable)
              return (
                <button
                  key={d.key}
                  className={`lib-dept-card${dept === d.key ? ' on' : ''}${list.length ? '' : ' empty'}`}
                  style={{ ['--dept-hue' as string]: deptHueVar(d.key) }}
                  data-tip={list.length ? undefined : `as skills de ${d.name} chegam na rodada desta função`}
                  onClick={() => setDept(d.key)}
                >
                  <span className="lib-dept-icon">{d.icon}</span>
                  <span className="lib-dept-name">{d.name}</span>
                  <span className="lib-dept-count">{list.length ? `${inst}/${list.length}` : 'em breve'}</span>
                  {upd && <span className="lib-dept-upd">⟳</span>}
                </button>
              )
            })}
          </div>
          <div className="skills-lib-actions">
            {allPend.length > 0 && (
              <button
                className="btn tiny"
                disabled={busyAll}
                data-tip={
                  'baixa TODA a curadoria não-instalada de uma vez — as 8 funções,\nskills E subagentes, agrupado por repositório para caber na cota.\nSe a cota do GitHub estourar no meio, o que baixou FICA:\nclique de novo depois (ou salve o 🔑 token: 60/h → 5.000/h)'
                }
                onClick={() => void installEverything()}
              >
                {busyAll ? 'instalando…' : `⭳ instalar tudo (${allPend.length})`}
              </button>
            )}
            {notInstalled.length > 1 && (
              <button
                className="btn ghost tiny"
                disabled={busyAll}
                data-tip={`baixa só os itens não-instalados desta função`}
                onClick={() => void installAll()}
              >
                {busyAll ? 'instalando…' : `⭳ ${dept} (${notInstalled.length})`}
              </button>
            )}
            <button
              className="btn ghost tiny"
              data-tip={
                isAgent
                  ? 'instala um subagente de fora da curadoria — cole o link do\nARQUIVO .md do agente no GitHub (blob ou raw);\nentra na função selecionada acima'
                  : 'instala uma skill de fora da curadoria, de um repo do GitHub,\nna função selecionada acima'
              }
              onClick={() => setShowAdd((v) => !v)}
            >
              {showAdd ? '× fechar' : `+ adicionar ${isAgent ? 'subagente' : 'skill'}`}
            </button>
            <>
                <button
                  className="btn ghost tiny"
                  disabled={ioBusy}
                  data-tip={
                    'salva TUDO num único .zip — as 8 funções de uma vez:\nskills + subagentes instalados + as adicionadas por você\n+ versões pinadas. Nunca é por função: é a biblioteca inteira.'
                  }
                  onClick={() => void runIo('exportLib')}
                >
                  ⇪ exportar tudo
                </button>
                <button
                  className="btn ghost tiny"
                  disabled={ioBusy}
                  data-tip={
                    'restaura o .zip no outro PC de UMA vez, 100% offline —\ncada item volta sozinho para a função dele (front, cyber, data…):\no catálogo sabe de quem é cada skill/subagente'
                  }
                  onClick={() => void runIo('importLib')}
                >
                  ⇥ importar tudo
                </button>
                <button
                  className="btn ghost tiny"
                  data-tip={
                    settings?.githubTokenConfigured
                      ? 'token do GitHub ATIVO — cota de instalação 5.000/h\n(clique para trocar ou remover; o valor nunca é exibido)'
                      : 'opcional: token do GitHub (fine-grained, SEM permissão nenhuma —\nsó leitura pública) sobe a cota de instalação de 60/h para 5.000/h.\ncrie em github.com/settings/personal-access-tokens'
                  }
                  onClick={() => setShowToken((v) => !v)}
                >
                  {showToken ? '× token' : `🔑 token${settings?.githubTokenConfigured ? ' ✓' : ''}`}
                </button>
            </>
            {ioMsg && <span className="skills-io-msg">✓ {ioMsg}</span>}
          </div>
          {showAdd && (
            <div className="skills-add">
              <input
                className="skills-add-input"
                placeholder={
                  isAgent
                    ? `URL do ARQUIVO .md do agente (…/blob/main/agents/nome.md) · entra em "${dept}"`
                    : `URL do GitHub — repo (owner/repo) ou pasta da skill (…/tree/main/skills/nome) · entra em "${dept}"`
                }
                value={addUrl}
                onChange={(e) => setAddUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void addCustom()}
              />
              <button
                className="btn tiny"
                disabled={adding || !addUrl.trim()}
                onClick={() => void addCustom()}
              >
                {adding ? 'baixando…' : 'adicionar'}
              </button>
            </div>
          )}
          {showToken && (
            <div className="skills-add">
              <input
                className="skills-add-input"
                type="password"
                placeholder={
                  settings?.githubTokenConfigured
                    ? 'token definido — digite um novo para trocar'
                    : 'github_pat_… (fine-grained, sem nenhuma permissão — só leitura pública)'
                }
                value={tokenDraft}
                onChange={(e) => setTokenDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void saveToken()}
              />
              <button
                className="btn tiny"
                disabled={!tokenDraft.trim()}
                onClick={() => void saveToken()}
              >
                salvar
              </button>
              {settings?.githubTokenConfigured && (
                <button className="btn ghost tiny" onClick={() => void clearToken()}>
                  × remover
                </button>
              )}
            </div>
          )}
          {err && <div className="skill-err">{err}</div>}
          {shown.length === 0 ? (
            <div className="skills-lib-empty">
              {isAgent ? (
                <>
                  os subagentes de <b>{dept}</b> chegam na rodada desta função.
                </>
              ) : (
                <>
                  as skills de <b>{dept}</b> chegam na rodada desta função — por enquanto, dá para
                  adicionar as suas com "+ adicionar skill".
                </>
              )}
            </div>
          ) : (
            <div className="skills-lib-grid">
              {groups.map((g) => (
                <div key={g.name} className="skills-lib-group">
                  <div className="skills-lib-group-title">{g.name}</div>
                  {g.items.map((sk) => (
                    <div key={sk.id} className={`skill-row${sk.installed ? ' inst' : ''}`}>
                      <span
                        className="skill-name"
                        data-tip={`${sk.kind === 'agent' ? '⬡ SUBAGENTE · ' : ''}${sk.summary}\nfonte: ${sk.repo}${
                          sk.requires?.length ? `\ninstala junto: ${sk.requires.join(', ')}` : ''
                        }`}
                      >
                        {sk.kind === 'agent' ? `⬡ ${sk.id}` : `/${sk.id}`}
                      </span>
                      <span className="skill-spacer" />
                      {busy === sk.id ? (
                        <span className="skill-busy">instalando…</span>
                      ) : sk.installed ? (
                        <>
                          {sk.supplyChainDecision === 'review' && (
                            <span
                              className="func-badge warn"
                              data-tip={`${sk.supplyChainFindings ?? 0} sinal(is) local(is) de supply chain. A skill continua subordinada à política do Synkora e só deve ser usada no escopo certo.${sk.licenseFiles?.length ? `\nlicença: ${sk.licenseFiles.join(', ')}` : ''}`}
                            >
                              revisar
                            </span>
                          )}
                          {sk.supplyChainDecision === 'block' && (
                            <span
                              className="func-badge warn"
                              data-tip={`${sk.supplyChainFindings ?? 0} sinal(is) crítico(s). O pacote permanece visível para remoção, mas não pode ser injetado nem executado.`}
                            >
                              bloqueada
                            </span>
                          )}
                          {sk.updateAvailable && (
                            <button
                              className="btn tiny"
                              data-tip="a fonte mudou — baixar a versão nova"
                              onClick={() => void run('update', sk.id)}
                            >
                              ⟳ atualizar
                            </button>
                          )}
                          <span
                            className="skill-state"
                            data-tip={sk.sha ? `instalada · versão ${sk.sha.slice(0, 7)}` : 'instalada'}
                          >
                            ✓
                          </span>
                          <button
                            className="btn ghost tiny"
                            data-tip="remover da biblioteca (máquina toda)"
                            onClick={() => void run('remove', sk.id)}
                          >
                            ×
                          </button>
                        </>
                      ) : (
                        <button className="btn ghost tiny" onClick={() => void run('install', sk.id)}>
                          instalar
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  )
}
