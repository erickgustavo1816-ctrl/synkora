import { useEffect, useState } from 'react'
import { useStore } from '../store'
import Select from './Select'

// Extraído do Board (F3.9): usado pelo modal de tarefa, pelo modal de missão e
// pela troca de conta da fase.
export function ModelSelect({
  cli,
  seatId,
  value,
  onChange,
  disabled
}: {
  cli: 'claude' | 'codex'
  seatId?: string
  value: string
  onChange: (model: string) => void
  disabled?: boolean
}): React.JSX.Element {
  // Lista REAL do seat: claude via handshake do CLI, codex via debug models —
  // cacheada por cli+seat. Nada de digitar modelo na mão, salvo "outro…".
  const key = `${cli}:${seatId ?? ''}`
  const catalog = useStore((s) => s.catalogByCli[key])
  const loadCatalog = useStore((s) => s.loadCatalog)

  useEffect(() => {
    if (!disabled) void loadCatalog(cli, seatId)
  }, [key, cli, seatId, loadCatalog, disabled])

  const loaded = Boolean(catalog)
  const options = [
    { value: '', label: loaded ? 'padrão do seat' : 'carregando modelos…' },
    ...(catalog?.models ?? []).map((m) => ({ value: m.id, label: m.label }))
  ]
  const [custom, setCustom] = useState(false)

  useEffect(() => {
    // Só cai no texto livre quando a lista JÁ carregou e o valor não está nela
    // (valor antigo/manual). Enquanto carrega, mostra o select com o valor.
    setCustom(!disabled && loaded && value !== '' && !options.some((o) => o.value === value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, value, loaded, disabled])

  // Sem seat escolhido não há de onde puxar modelos — trava até escolher.
  if (disabled) {
    return (
      <Select
        className="model-select"
        value=""
        options={[]}
        placeholder="— escolha o seat primeiro —"
        onChange={() => undefined}
        disabled
      />
    )
  }

  if (custom) {
    return (
      <input
        className="model-input"
        autoFocus
        placeholder="id do modelo…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => {
          if (!value.trim()) setCustom(false)
        }}
      />
    )
  }
  // valor salvo ainda fora da lista (carregando): opção provisória para o
  // select não renderizar vazio; sentinela "__custom__" alterna p/ texto livre
  const selOptions = [
    ...(value !== '' && !options.some((o) => o.value === value)
      ? [{ value, label: value }]
      : []),
    ...options,
    { value: '__custom__', label: 'outro…' }
  ]
  return (
    <Select
      className="model-select"
      value={value}
      options={selOptions}
      onChange={(v) => {
        if (v === '__custom__') {
          setCustom(true)
          onChange('')
        } else {
          onChange(v)
        }
      }}
    />
  )
}
