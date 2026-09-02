/**
 * O HOOK QUE ALCANÇA TODA TOOL (D4 da R39, 2026-09-02).
 *
 * O CASO MEDIDO (01/09, missão 86a05c06, fable xhigh em 451k de contexto): as
 * falas do dono foram entregues e o modelo emendou SEIS chamadas de tool —
 * `helper_send`×3, `delegate`×2, `helpers_status` — recusadas uma a uma pela
 * dívida de resposta, antes de escrever a primeira linha de texto. Oito
 * minutos entre a primeira fala e a resposta. Ele lia cada recusa como "essa
 * tool falhou, tento outra".
 *
 * A guarda da R32 mora no nosso servidor MCP, e ali ela alcança só as tools do
 * Synkora: `Bash`, `Read`, `Edit` e `AskUserQuestion` nunca passam por lá. Este
 * módulo é a metade que fecha o buraco no claude — um hook `PreToolUse`
 * declarado no `--settings` do pane, que roda antes de CADA tool, nativa
 * inclusive, e devolve o bloqueio quando existe BANDEIRA em disco para aquele
 * pane (`GuiOwnerReplyDebt.arm` escreve, `clear` apaga).
 *
 * TUDO AQUI É SONDADO, não suposto (`scripts/probe-claude-pretooluse-block.mjs`,
 * claude 2.1.258; relatório em
 * `.synkora/reports/PROBE_PRETOOLUSE_BLOCK_2026-09-02.md`):
 *
 * 1. O SHELL DO HOOK NO WINDOWS É `/usr/bin/bash`, NÃO cmd.exe. O
 *    `--debug-file` do próprio binário entregou a prova. Um comando `cmd /c …`
 *    sob bash devolve o BANNER do cmd na stdout do hook, o claude o trata como
 *    texto puro e A TOOL RODA — bloqueio nenhum. Por isso o comando é POSIX e
 *    o caminho da bandeira vai em BARRA NORMAL (o bash come a contrabarra).
 * 2. As três formas de bloqueio funcionam (deny-json, `decision:"block"` legado
 *    e exit 2 + stderr). Escolhemos a `deny-json`: é a estruturada, sai pela
 *    STDOUT com exit 0 e por isso dispensa `1>&2` e `exit 2` — os dois
 *    metacaracteres mais perigosos do item 3.
 * 3. NENHUM METACARACTERE DE CMD (`& < > ( ) @ ^ | %`) pode entrar no comando.
 *    O `maestroSession` passa `--settings` como JSON INLINE duplamente
 *    aspeado, num spawn com `shell: true`; o cmd.exe alterna o estado de aspas
 *    a CADA `"` — inclusive nas escapadas — e acaba lendo o conteúdo das
 *    strings do JSON como se estivesse FORA de aspas. O cenário `inline-args`
 *    da sonda mediu a coisa inteira ponta a ponta e passou.
 * 4. Custo: 28,3 ms de mediana no caminho de 99% (bandeira ausente). Cada
 *    passo do modelo naquela conversa custava 40–90 SEGUNDOS.
 *
 * Se a máquina não tiver git-bash, o comando falha com exit ≠ 0 — que é erro
 * NÃO-bloqueante no claude: a guarda fica inerte e sobram a guarda do MCP e a
 * persona. Degrada, não crasha.
 */

import { join } from 'node:path'

/** Teto do nome de arquivo (o Windows para em 255; 120 sobra e não assusta). */
const FLAG_NAME_MAX = 120

/** Segundos que o claude espera pelo hook. O comando mede 28 ms — o teto só
 *  existe para que uma máquina engasgada não segure o turno. */
const HOOK_TIMEOUT_SECONDS = 10

export type ClaudeHookCommand = { type: 'command'; command: string; timeout: number }
export type ClaudeHookMatcher = { matcher: string; hooks: ClaudeHookCommand[] }
export type ClaudeHookSettings = { hooks: { PreToolUse: ClaudeHookMatcher[] } }

/**
 * O caminho da bandeira deste pane. O `paneId` vira NOME DE ARQUIVO — e no
 * Windows isso proíbe `: / \ ? * " < > |` (armadilha permanente da casa) —,
 * então ele passa pela mesma peneira que o harness já usa para os ajudantes.
 */
export function guiOwnerDebtFlagPath(flagDir: string, paneId: string): string {
  const safe = paneId.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, FLAG_NAME_MAX) || 'pane'
  return join(flagDir, `${safe}.txt`)
}

/**
 * O comando do hook: POSIX, caminho em barra normal, e sem um único
 * metacaractere de cmd. Quando a bandeira existe, o `cat` despeja o ENVELOPE
 * pronto que está dentro dela (veja `guiOwnerDebtHookPayload`); quando não
 * existe, o `if` não faz nada e o claude segue — é o caminho de 99% dos passos.
 */
export function guiOwnerDebtHookCommand(flagPath: string): string {
  const posix = flagPath.replace(/\\/gu, '/')
  return `if [ -f "${posix}" ]; then cat "${posix}"; fi`
}

/** O bloco `hooks` do `--settings`. Matcher `*`: TODA tool, nativa inclusive —
 *  foi trocar de tool cinco vezes que custou os oito minutos de 01/09. */
export function guiOwnerDebtHookSettings(flagPath: string): ClaudeHookSettings {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [
            { type: 'command', command: guiOwnerDebtHookCommand(flagPath), timeout: HOOK_TIMEOUT_SECONDS }
          ]
        }
      ]
    }
  }
}

/**
 * O CONTEÚDO da bandeira — o envelope que o binário honrou na sonda:
 * `permissionDecision: "deny"` com o motivo dentro. É por isso que o arquivo
 * guarda JSON e não a recusa crua: a sonda mediu que texto puro na STDOUT vira
 * "plain text" e NÃO bloqueia; só a forma exit-2 + stderr bloquearia com texto
 * cru, e ela exige `1>&2` e `exit 2` — os metacaracteres que o `--settings`
 * inline não deixa passar.
 *
 * ASCII puro de propósito: o arquivo viaja por `cat` até o parser do claude, e
 * `\uXXXX` é JSON válido imune a qualquer história de codepage (o em-dash cru
 * também passou na medição — o escape é cinto, não muleta).
 */
export function guiOwnerDebtHookPayload(reason: string): string {
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  }
  return JSON.stringify(payload).replace(
    /[\u0080-\uffff]/gu,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
}

export type ClaudeSettingsParts = { fastMode?: boolean } & Record<string, unknown>

/**
 * O `--settings` do claude é UM só: o `/fast` (que em modo SDK só liga pela
 * CHAVE de settings) e o hook da dívida precisam viajar fundidos, ou o último a
 * escrever apagaria o outro.
 *
 * `fastMode` falso ou ausente NÃO vira chave: sem isso todo pane passaria a
 * carregar `--settings` e o comportamento de quem nunca pediu `/fast` mudaria
 * por tabela. Devolver `{}` é o sinal de "não passe `--settings`".
 */
export function mergeClaudeSettings(parts: ClaudeSettingsParts): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parts)) {
    if (key === 'fastMode') continue
    if (value !== undefined) merged[key] = value
  }
  if (parts.fastMode) merged.fastMode = true
  return merged
}
