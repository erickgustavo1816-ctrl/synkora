/**
 * O TOQUE DE REVISÃO — o texto que o botão 🧐 do trilho entrega ao chat.
 *
 * Ordem do dono (2026-08-18): o revisar parou de ABRIR conversa de revisor. Ele
 * dá um TOQUE no agente da missão — a mensagem entra no fio como fala do DONO e
 * quem abre o ajudante de revisão é o próprio agente, pelo `delegate` do MCP. É
 * o único caminho em que modelo, effort e conta do revisor aparecem na lateral;
 * o subagente NATIVO nunca disse nenhum dos três, e foi por isso que ele saiu.
 *
 * O texto mora AQUI, fora do componente, por duas razões: ele é CONTRATO — o
 * mandato estrito do dono, com a régua "reviewer nunca legisla capacidade nova"
 * que custou uma missão inteira para ser escrita (F6.14) — e o teste precisa
 * prendê-lo LITERALMENTE, o que um `.tsx` não permite (as suítes carregam os
 * módulos com type-stripping do node, que não entende JSX).
 *
 * Um parágrafo só, na voz do dono: é uma fala dele no chat, não um briefing.
 */
export const REVIEW_NUDGE_TEXT = [
  'Abre UM ajudante de revisão de código pelo `delegate` do MCP synkora — um só —',
  'e passa a ele este mandato ESTRITO: olhar o diff desta branch e dizer se o código',
  'está limpo, se está bem escrito e onde há oportunidade de refatoração.',
  'Só isso: nada de QA, de subir o app ou de testar comportamento, e nada de exigir',
  'capacidade que a missão nunca prometeu (migração, rollback, telemetria, feature',
  'flag, hardening) — o que for desse tipo entra como sugestão, nunca como bloqueio.',
  'Se eu não tiver dito modelo e effort, usa os padrões que eu carimbei no painel de',
  'delegação. Depois pega o resultado com `helper_result` e me traz aqui a lista de',
  'achados ordenada por gravidade, da mais grave para a mais leve, cada uma com',
  'arquivo, linha e o porquê.'
].join(' ')
