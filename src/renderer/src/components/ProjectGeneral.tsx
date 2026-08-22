// ✦ GERAL = A PORTA DE ENTRADA DO UNIVERSO (ordem do dono, 2026-08-15).
//
// "Não quero mais aquela página geral — a landing do projeto tem que ser a
// pessoa criando uma missão." O RETRATO POR VERSÃO (◈ V1.0 · N missões · em
// execução · concluídas) que ocupava esta tela mudou de casa: foi para a aba
// VERSÕES, onde ele convive com as versões que descreve ("uma página inteira
// para aquilo não faz sentido").
//
// ESTE ARQUIVO É SÓ O CONVITE — o universo com ZERO missões. Assim que existe
// uma missão (de qualquer status) o Board troca esta tela pelo `DockGeneral`
// (o retrato compacto do RIGHTDOCK): quem já tem história merece o retrato,
// não o convite.
//
// A FOTO DO UNIVERSO SAIU DAQUI (2026-08-15, mesma ordem): o rodapé de
// identidade morreu e a troca passou a viver nos DOIS avatares que já mostram
// o universo no alto da janela — o do titlebar (`.tb-title-avatar`) e o do
// cabeçalho do workspace (`.ws-avatar`). Um convite não tem rodapé.

export default function ProjectGeneral({
  missionCount,
  onNewMission
}: {
  /** missões do universo em QUALQUER status — zero é o que traz esta tela */
  missionCount: number
  onNewMission: () => void
}): React.JSX.Element {
  // Cinto: com o branch do Board esta tela só nasce em `missionCount === 0`.
  // A cópia de "mais uma" fica como rota de saída honesta se alguém montar o
  // convite noutro contexto — nunca como número inventado.
  const first = missionCount === 0

  return (
    <div className={`project-general${first ? ' is-invite' : ''}`}>
      <section className="pg-start">
        <p className="pg-start-title">{first ? 'crie a primeira missão' : 'abra uma missão'}</p>
        <p className="pg-start-text">
          {first ? (
            <>
              Todo trabalho deste universo nasce como missão: uma conversa com o agente já
              dentro de um worktree próprio. No modal você escolhe <b>produto</b> — branch
              isolada, que entra na fila ⇪ quando ficar pronta — ou <b>planejamento</b>, a
              conversa que escreve o <code>plano/</code> na raiz.
            </>
          ) : (
            <>
              As missões abertas estão na coluna ao lado — clique numa para voltar à conversa
              dela. Frente nova de trabalho pede missão nova, com worktree próprio.
            </>
          )}
        </p>
        <button
          className="btn accent pg-start-cta"
          data-tip={
            'Nova missão: branch e worktree próprios, com o agente já dentro.\n' +
            'No modal dá para escolher PLANEJAMENTO — a conversa que escreve o plano/ na raiz.'
          }
          onClick={onNewMission}
        >
          + nova missão
        </button>
      </section>
    </div>
  )
}
