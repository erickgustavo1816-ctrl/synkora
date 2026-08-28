// A MENSAGEM DE SPAWN QUE MENTIA (incidente 2026-08-28).
//
// O dono viu na tela, em série:
//   falhou spawn C:\WINDOWS\system32\cmd.exe ENOENT
//   falhou handshake do codex falhou: spawn ... ENOENT
//   falhou a sessão encerrou com código -4058
//
// Nada disso é verdade sobre o `cmd.exe`, que existe. No Node, um `cwd`
// INEXISTENTE falha exatamente assim — o erro nomeia o executável e cala sobre
// a pasta (provado em sonda direta: `spawn(cmd, {cwd: 'C:/nao/existe'})`
// devolve `ENOENT` com esta mesma frase). E -4058 é só o UV_ENOENT do mesmo
// tropeço, em número.
//
// O caso real: a missão integrou, o worktree dela saiu do disco (removido ou
// posto em quarentena pelo reparo) e o pane continuou tentando renascer ali.
// A mensagem honesta nomeia a PASTA e a receita — beco sem saída é bug.

/** `true` quando o tropeço é o do cwd que sumiu, e não um binário ausente. */
export function isMissingCwdSpawnFailure(input: {
  code?: string
  cwdExists: boolean
}): boolean {
  return input.code === 'ENOENT' && !input.cwdExists
}

/**
 * O texto que vai ao fio. Fora do caso provado, a mensagem ORIGINAL passa
 * intacta: traduzir um erro que não se entende seria trocar uma verdade crua
 * por um palpite.
 */
export function sessionSpawnFailureText(input: {
  message: string
  code?: string
  cwd?: string
  cwdExists: boolean
}): string {
  if (!isMissingCwdSpawnFailure(input)) return input.message
  const onde = input.cwd?.trim()
  return (
    'a pasta desta conversa não existe mais' +
    (onde ? ` (${onde})` : '') +
    ' — o worktree foi removido ou posto em quarentena depois que a missão integrou. ' +
    'Reinicie o Synkora: o reparo do boot reconcilia a missão e o card sai da coluna.'
  )
}
