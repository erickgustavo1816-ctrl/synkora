// Ponte tipada do `missions:workspaceFiles` (Synkora 2.0, onda D).
//
// O trilho de entrega precisa responder, sem o dono abrir um terminal, à
// pergunta que ele faz toda vez antes do ⇪: "o que essa branch mudou?". O main
// (agente MOTOR desta onda) mede o diffstat do worktree contra a base e devolve
// a lista de arquivos com o status de cada um.
//
// Mesmo padrão de `guiApi.ts`/`missionGui.ts`: enquanto as duas frentes da onda
// não mesclam, o preload deste worktree ainda não declara `workspaceFiles`,
// então o acesso passa por um cast estreito resolvido A CADA CHAMADA (o
// namespace pode nascer depois deste módulo ser importado).
// TODO(onda D, motor): quando o preload publicar o tipo, trocar `bridge()` por
// `window.synkora.missions` e apagar as interfaces locais — nada fora daqui
// muda.
//
// Ele é a ÚNICA costura do renderer com esse canal: nenhum componente chama
// `window.synkora.missions.workspaceFiles` direto.

/** Status de cada arquivo, no vocabulário do git (`git status --porcelain`).
 *  Desconhecido cai no glifo neutro — status novo do motor nunca quebra a UI. */
export type MissionFileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'U' | '?' | string

export interface MissionWorkspaceFile {
  path: string
  status: MissionFileStatus
}

export interface MissionWorkspaceSummary {
  /** commits à frente da base */
  ahead: number
  insertions: number
  deletions: number
  files: MissionWorkspaceFile[]
}

export interface MissionWorkspaceResult {
  ok: boolean
  summary?: MissionWorkspaceSummary
  error?: string
}

interface MissionWorkspaceBridge {
  workspaceFiles: (missionId: string) => Promise<MissionWorkspaceResult>
}

function bridge(): Partial<MissionWorkspaceBridge> | undefined {
  return (window as unknown as { synkora?: { missions?: Partial<MissionWorkspaceBridge> } })
    .synkora?.missions
}

const NO_BRIDGE =
  'reinicie o app (npm run dev) para ver o diff desta branch — esta janela ainda não tem a ponte'

/** Normaliza o que veio do canal: um payload torto (motor antigo, campo
 *  faltando) vira "sem resumo" em vez de derrubar o trilho inteiro. */
function normalize(raw: unknown): MissionWorkspaceResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: NO_BRIDGE }
  const res = raw as MissionWorkspaceResult
  if (!res.ok) return { ok: false, error: res.error ?? 'não deu para ler o diff desta branch' }
  const s = res.summary
  if (!s || typeof s !== 'object') return { ok: true }
  return {
    ok: true,
    summary: {
      ahead: Number.isFinite(s.ahead) ? s.ahead : 0,
      insertions: Number.isFinite(s.insertions) ? s.insertions : 0,
      deletions: Number.isFinite(s.deletions) ? s.deletions : 0,
      files: Array.isArray(s.files)
        ? s.files
            .filter((f): f is MissionWorkspaceFile => Boolean(f) && typeof f.path === 'string')
            .map((f) => ({ path: f.path, status: typeof f.status === 'string' ? f.status : '?' }))
        : []
    }
  }
}

export const missionWorkspace = {
  /** false = preload sem `workspaceFiles` (devMock/browser puro, ou motor
   *  ainda não mesclado). O trilho mostra o aviso em vez de inventar número. */
  available(): boolean {
    return typeof bridge()?.workspaceFiles === 'function'
  },

  async files(missionId: string): Promise<MissionWorkspaceResult> {
    const api = bridge()
    if (typeof api?.workspaceFiles !== 'function') return { ok: false, error: NO_BRIDGE }
    try {
      return normalize(await api.workspaceFiles(missionId))
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
}
