import { useEffect, useRef } from 'react'
import type { GuiCliCommand } from '../guiApi'

// AUTOCOMPLETE DE COMANDOS (2.0). A lista NÃO é inventada nem varrida do
// disco: vem das caps REAIS do CLI (evento `ready`) — no claude o handshake
// já entrega built-ins, skills e comandos personalizados com descrição; no
// codex é o cardápio que o app-server atende. Por isso comando personalizado
// aparece aqui sozinho, sem nenhum catálogo nosso para manter.
//
// Os nomes chegam SEM a barra nos dois CLIs — quem normaliza é este módulo.

/** '/nome' a partir do name cru das caps. */
export function slashName(command: GuiCliCommand): string {
  return command.name.startsWith('/') ? command.name : `/${command.name}`
}

/**
 * O trecho digitado que abre o menu: barra no começo do texto ou depois de um
 * espaço, até o cursor. Dentro de cerca de código (``` ímpares antes do
 * cursor) NÃO abre — ali a barra é conteúdo, não comando.
 */
export function slashQueryAt(text: string, cursor: number): { at: number; query: string } | null {
  const before = text.slice(0, cursor)
  if ((before.match(/```/gu)?.length ?? 0) % 2 === 1) return null
  const match = /(?:^|\s)(\/\S*)$/u.exec(before)
  if (!match) return null
  const token = match[1]
  return { at: before.length - token.length, query: token.slice(1).toLowerCase() }
}

/**
 * Filtro em três degraus (mesma régua do fork): prefixo do nome primeiro —
 * é o que a pessoa está tentando completar —, depois nome contendo, e só
 * então descrição. Consulta com ':' (comando de plugin) para no prefixo.
 */
export function filterSlashCommands(
  commands: GuiCliCommand[],
  query: string
): GuiCliCommand[] {
  if (!query) return commands
  const byPrefix = commands.filter((c) => slashName(c).slice(1).toLowerCase().startsWith(query))
  if (byPrefix.length || query.includes(':')) return byPrefix
  const byName = commands.filter((c) => slashName(c).toLowerCase().includes(query))
  if (byName.length) return byName
  return commands.filter((c) => (c.description ?? '').toLowerCase().includes(query))
}

export default function GuiSlashMenu({
  commands,
  index,
  onPick,
  onHover
}: {
  commands: GuiCliCommand[]
  index: number
  onPick: (command: GuiCliCommand) => void
  onHover: (index: number) => void
}): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)

  // Navegar com o teclado precisa arrastar a lista junto — item selecionado
  // fora da vista faz o menu parecer travado.
  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('.gui-slash-item.active')
    active?.scrollIntoView({ block: 'nearest' })
  }, [index])

  return (
    <div className="gui-slash-menu" role="listbox" aria-label="Comandos" ref={listRef}>
      {commands.map((command, i) => (
        <button
          key={command.name}
          type="button"
          role="option"
          aria-selected={i === index}
          className={`gui-slash-item${i === index ? ' active' : ''}`}
          // mousedown apagaria o foco do composer antes do clique resolver
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => onHover(i)}
          onClick={() => onPick(command)}
        >
          <b className="gs-name">{slashName(command)}</b>
          {command.argumentHint && <span className="gs-arg">{command.argumentHint}</span>}
          {command.description && <span className="gs-desc">{command.description}</span>}
        </button>
      ))}
    </div>
  )
}
