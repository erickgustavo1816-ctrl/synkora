// A GUARDA UNIVERSAL DA DÍVIDA DE RESPOSTA (D4 do
// DESIGN_FALA_DO_DONO_PARA_O_TURNO_2026-09-02).
//
// O CASO MEDIDO (01/09, missão 86a05c06): entregue a fala do dono, o modelo
// fez SEIS chamadas de tool — helper_send×3, delegate×2, helpers_status — que
// a dívida do MCP recusou uma a uma, e só depois escreveu texto. Ele tratou
// cada recusa como "essa tool falhou, tento outra". E `Bash`/`Read`/`Edit`/
// `AskUserQuestion` nem passam pelo nosso MCP: ali a guarda não existia.
//
// Esta suíte prova a metade que fecha o buraco: a BANDEIRA em disco que um
// hook `PreToolUse` do claude lê antes de CADA tool, e a forma exata do
// comando — sondada no binário 2.1.258 (`scripts/probe-claude-pretooluse-block.mjs`,
// relatório em `.synkora/reports/PROBE_PRETOOLUSE_BLOCK_2026-09-02.md`).
//
// Nada aqui roda o CLI: a sonda mediu, a suíte guarda o resultado.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename, dirname } from 'node:path'

// Como rodar: `npm run test:gui-owner-debt-hook` — SEMPRE pelo npm, porque o
// script recompila os dois módulos em `.tmp/` antes do node (o `.mjs` solto
// rodaria a compilação velha). É o padrão de test:gui-sessions.
import {
  guiOwnerDebtFlagPath,
  guiOwnerDebtHookCommand,
  guiOwnerDebtHookSettings,
  guiOwnerDebtHookPayload,
  mergeClaudeSettings
} from '../.tmp/gui-owner-debt-hook-test/guiOwnerDebtHook.js'
import {
  GuiOwnerReplyDebt,
  guiOwnerReplyRefusal,
  sweepFlags
} from '../.tmp/gui-owner-debt-hook-test/guiOwnerReplyDebt.js'

/** Os metacaracteres que o cmd.exe interpreta. Eles NÃO podem existir no
 *  comando do hook: no `--settings` inline (a forma do maestroSession) o cmd
 *  alterna o estado de aspas a cada `"`, escapadas inclusive, e lê o conteúdo
 *  das strings do JSON como se estivesse FORA de aspas. */
const CMD_METACHARS = /[&<>()@^|%]/u

// ————— 1. O CAMINHO DA BANDEIRA (paneId vira NOME DE ARQUIVO) —————

test('o paneId é sanitizado: nem `:` nem `/` nem `\\` chegam ao nome do arquivo', () => {
  const dir = 'C:\\Users\\Erick\\AppData\\Roaming\\synkora\\owner-debt'
  const path = guiOwnerDebtFlagPath(dir, 'gui:pane/dev\\86a0?5c*06')
  const name = basename(path)
  assert.equal(dirname(path), dir, 'a bandeira saiu da pasta que lhe foi dada')
  assert.doesNotMatch(name, /[:/\\?*"<>|]/u, `o Windows recusaria este nome: ${name}`)
  assert.match(name, /\.txt$/u, 'a bandeira não termina em .txt')
  assert.match(name, /gui/u, 'a sanitização apagou a identidade do pane')
})

test('paneId vazio ou só de lixo ainda produz um nome de arquivo válido', () => {
  for (const paneId of ['', '///', ':::', '\\']) {
    const name = basename(guiOwnerDebtFlagPath('C:\\flags', paneId))
    assert.doesNotMatch(name, /[:/\\?*"<>|]/u, `nome inválido para paneId ${JSON.stringify(paneId)}`)
    assert.ok(name.length > 4, `nome vazio para paneId ${JSON.stringify(paneId)}: ${name}`)
  }
})

test('paneId absurdamente longo não estoura o teto de nome do Windows', () => {
  const name = basename(guiOwnerDebtFlagPath('C:\\flags', 'p'.repeat(600)))
  assert.ok(name.length <= 140, `nome com ${name.length} chars — o Windows para em 255`)
})

test('dois panes diferentes nunca dividem a mesma bandeira', () => {
  const a = guiOwnerDebtFlagPath('C:\\flags', 'pane-a')
  const b = guiOwnerDebtFlagPath('C:\\flags', 'pane-b')
  assert.notEqual(a, b)
})

// ————— 2. O COMANDO DO HOOK (a forma SONDADA, não a suposta) —————
//
// A sonda derrubou a suposição de partida do design: o claude NÃO roda o
// comando do hook em cmd.exe no Windows — ele roda em `/usr/bin/bash`, e o
// `--debug-file` do próprio binário entregou a prova ("/usr/bin/bash: line 1:
// …: command not found"). Um `cmd /c …` sob bash devolve o BANNER do cmd e o
// claude o trata como texto puro: bloqueio nenhum, a tool ROdou.

test('o comando do hook é POSIX com caminho em barra normal — a forma que a sonda honrou', () => {
  const cmd = guiOwnerDebtHookCommand('C:\\Users\\Erick\\AppData\\Roaming\\synkora\\owner-debt\\p1.txt')
  assert.match(cmd, /^if \[ -f "/u, 'o comando não abre com o teste POSIX de arquivo')
  assert.match(cmd, /\bcat\b/u, 'o comando não despeja o conteúdo da bandeira')
  assert.match(cmd, /fi$/u, 'o comando não fecha o if')
  assert.match(cmd, /C:\/Users\//u, 'o caminho não foi convertido para barra normal (o bash come a contrabarra)')
  assert.doesNotMatch(cmd, /\\/u, 'sobrou contrabarra no caminho — o bash a comeria')
  assert.doesNotMatch(cmd, /cmd \/c/iu, 'voltou o `cmd /c`, que a sonda provou NÃO bloquear')
  assert.doesNotMatch(cmd, /powershell/iu, 'PowerShell no hook: proibido (custo e aspas)')
})

test('o comando não carrega nenhum metacaractere do cmd — ele atravessa o --settings inline', () => {
  const cmd = guiOwnerDebtHookCommand('C:\\flags\\pane.txt')
  assert.doesNotMatch(cmd, CMD_METACHARS, `metacaractere no comando: ${cmd}`)
  assert.ok(cmd.length < 8192, `comando com ${cmd.length} chars — passou da zona de conforto do argv`)
})

test('o caminho vai entre aspas: pasta de usuário com espaço não quebra o hook', () => {
  const cmd = guiOwnerDebtHookCommand('C:\\Users\\John Doe\\AppData\\owner-debt\\p1.txt')
  assert.match(cmd, /"C:\/Users\/John Doe\/AppData\/owner-debt\/p1\.txt"/u, 'o caminho não foi aspeado')
})

// ————— 3. O BLOCO DE SETTINGS —————

test('o hook é PreToolUse com matcher `*` — toda tool, nativa inclusive', () => {
  const settings = guiOwnerDebtHookSettings('C:\\flags\\pane.txt')
  const entries = settings.hooks?.PreToolUse
  assert.ok(Array.isArray(entries) && entries.length === 1, 'esperava UMA entrada PreToolUse')
  assert.equal(entries[0].matcher, '*', 'o matcher não pega toda tool')
  const hooks = entries[0].hooks
  assert.ok(Array.isArray(hooks) && hooks.length === 1, 'esperava UM comando')
  assert.equal(hooks[0].type, 'command')
  assert.equal(hooks[0].command, guiOwnerDebtHookCommand('C:\\flags\\pane.txt'))
  assert.ok(typeof hooks[0].timeout === 'number' && hooks[0].timeout > 0, 'hook sem timeout')
  assert.deepEqual(Object.keys(settings), ['hooks'], 'o bloco do hook trouxe chave estranha junto')
})

test('o settings sobrevive à camada dupla de aspas do win32 (a forma do maestroSession)', () => {
  const settings = guiOwnerDebtHookSettings('C:\\Users\\Erick\\AppData\\Roaming\\synkora\\owner-debt\\p1.txt')
  const inner = JSON.stringify(settings)
  const arg = JSON.stringify(inner) // é ASSIM que o maestroSession empurra no argv do win32
  const backToInner = JSON.parse(arg)
  assert.deepEqual(JSON.parse(backToInner), settings, 'a ida e volta pela camada dupla perdeu o bloco')
  assert.doesNotMatch(arg, CMD_METACHARS, 'o argv final carrega metacaractere que o cmd comeria')
})

// ————— 4. A FUSÃO DOS SETTINGS —————

test('mergeClaudeSettings junta fastMode e hooks sem um comer o outro', () => {
  const hooks = guiOwnerDebtHookSettings('C:\\flags\\p.txt')
  assert.deepEqual(mergeClaudeSettings({}), {}, 'nada pedido, nada entregue')
  assert.deepEqual(mergeClaudeSettings({ fastMode: true }), { fastMode: true })
  assert.deepEqual(mergeClaudeSettings({ ...hooks }), hooks)
  const both = mergeClaudeSettings({ fastMode: true, ...hooks })
  assert.equal(both.fastMode, true)
  assert.deepEqual(both.hooks, hooks.hooks)
})

test('fastMode falso/ausente NÃO vira chave — o pane sem /fast continua como era', () => {
  assert.deepEqual(mergeClaudeSettings({ fastMode: false }), {})
  assert.deepEqual(mergeClaudeSettings({ fastMode: undefined }), {})
  const withHooks = mergeClaudeSettings({ fastMode: false, ...guiOwnerDebtHookSettings('C:\\f\\p.txt') })
  assert.equal('fastMode' in withHooks, false, 'fastMode:false vazou para o settings')
})

test('o maestroSession usa a fusão e mantém a camada dupla do win32', () => {
  // `includes` em vez de `assert.match`: o arquivo tem 60k+ chars e uma falha
  // de match despejaria o fonte inteiro no relatório do gate.
  const source = readFileSync(new URL('../src/main/maestroSession.ts', import.meta.url), 'utf8')
  assert.ok(source.includes('mergeClaudeSettings('), 'o maestroSession não passa pela fusão')
  assert.ok(source.includes('opts.settings'), 'o maestroSession não aceita settings de fora')
  assert.ok(
    source.includes("process.platform === 'win32' ? JSON.stringify("),
    'sumiu a camada extra de aspas do win32 — o cmd comeria o JSON'
  )
  assert.ok(
    !/JSON\.stringify\(\{ fastMode: true \}\)/u.test(source),
    'sobrou o bloco antigo que só sabia escrever fastMode — o hook seria apagado por ele'
  )
})

// ————— 5. A CARGA DA BANDEIRA (a forma de bloqueio sondada) —————

test('a bandeira carrega o envelope deny-json que o binário honrou', () => {
  const payload = JSON.parse(guiOwnerDebtHookPayload('PARE: o dono falou.'))
  assert.equal(payload.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(payload.hookSpecificOutput.permissionDecisionReason, 'PARE: o dono falou.')
})

test('a carga é ASCII puro — `cat` cospe BYTES e codepage não decide bloqueio', () => {
  const payload = guiOwnerDebtHookPayload('PARE: o DONO falou — não ouviu resposta ainda, você deve uma.')
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(payload, /[\u0080-\uffff]/u, 'sobrou byte alto na carga da bandeira')
  const reason = JSON.parse(payload).hookSpecificOutput.permissionDecisionReason
  assert.match(reason, /—/u, 'o escape \\uXXXX não voltou a ser o texto original')
  assert.match(reason, /você deve uma/u)
})

// ————— 6. A DÍVIDA ESCREVE E APAGA A BANDEIRA —————

function fakeFs() {
  const files = new Map()
  return {
    files,
    write: (path, text) => files.set(path, text),
    remove: (path) => files.delete(path),
    list: (dir) => [...files.keys()].filter((p) => dirname(p) === dir).map((p) => basename(p))
  }
}

test('arm escreve a bandeira com a recusa dentro; clear a apaga', () => {
  const fs = fakeFs()
  const debt = new GuiOwnerReplyDebt({ flagDir: 'C:\\flags', fs })
  debt.arm('gui:pane1', ['troca o dock de lado'])
  const path = guiOwnerDebtFlagPath('C:\\flags', 'gui:pane1')
  assert.ok(fs.files.has(path), 'arm não escreveu a bandeira')
  const reason = JSON.parse(fs.files.get(path)).hookSpecificOutput.permissionDecisionReason
  assert.equal(reason, guiOwnerReplyRefusal(['troca o dock de lado']))
  debt.clear('gui:pane1')
  assert.equal(fs.files.has(path), false, 'clear não apagou a bandeira')
})

test('a bandeira acompanha o POTE: a segunda fala re-escreve com as DUAS', () => {
  const fs = fakeFs()
  const debt = new GuiOwnerReplyDebt({ flagDir: 'C:\\flags', fs })
  debt.arm('p1', ['primeira'])
  debt.arm('p1', ['segunda'])
  const path = guiOwnerDebtFlagPath('C:\\flags', 'p1')
  const reason = JSON.parse(fs.files.get(path)).hookSpecificOutput.permissionDecisionReason
  assert.match(reason, /primeira/u)
  assert.match(reason, /segunda/u)
  assert.deepEqual(debt.pending('p1'), ['primeira', 'segunda'])
})

test('clear repetido e clear sem dívida não quebram nada', () => {
  const fs = fakeFs()
  const debt = new GuiOwnerReplyDebt({ flagDir: 'C:\\flags', fs })
  debt.clear('nunca-armado')
  debt.arm('p1', ['oi'])
  debt.clear('p1')
  debt.clear('p1')
  assert.equal(fs.files.size, 0)
  assert.equal(debt.pending('p1'), null)
})

test('fala vazia não arma nem escreve bandeira', () => {
  const fs = fakeFs()
  const debt = new GuiOwnerReplyDebt({ flagDir: 'C:\\flags', fs })
  debt.arm('p1', ['   ', ''])
  assert.equal(fs.files.size, 0)
  assert.equal(debt.pending('p1'), null)
})

test('a dívida em memória continua de pé mesmo sem flagDir configurado', () => {
  const debt = new GuiOwnerReplyDebt()
  debt.arm('p1', ['fala'])
  assert.deepEqual(debt.pending('p1'), ['fala'])
  debt.clear('p1')
  assert.equal(debt.pending('p1'), null)
})

// A COSTURA DO SPAWN: sem flagDir o pane nasce EXATAMENTE como nascia antes da
// R39 (sem `--settings`), e é assim que o app degrada se o boot não carimbar.
test('flagPathFor entrega o caminho ao spawn — e `undefined` antes do boot carimbar', () => {
  const antes = new GuiOwnerReplyDebt()
  assert.equal(antes.flagPathFor('gui:pane1'), undefined, 'sem flagDir o spawn não pode montar hook')
  antes.setFlagDir('C:\\Users\\Erick\\AppData\\Roaming\\synkora\\owner-debt')
  assert.equal(
    antes.flagPathFor('gui:pane1'),
    guiOwnerDebtFlagPath('C:\\Users\\Erick\\AppData\\Roaming\\synkora\\owner-debt', 'gui:pane1'),
    'o caminho do spawn e o caminho que arm escreve têm que ser O MESMO'
  )
  assert.equal(antes.flagPathFor(''), undefined, 'pane sem id não ganha bandeira')
})

test('a BANDEIRA é cinto, não pré-requisito: fs que explode não derruba a dívida', () => {
  const boom = {
    write: () => {
      throw new Error('EPERM')
    },
    remove: () => {
      throw new Error('EBUSY')
    },
    list: () => {
      throw new Error('ENOENT')
    }
  }
  const debt = new GuiOwnerReplyDebt({ flagDir: 'C:\\flags', fs: boom })
  assert.doesNotThrow(() => debt.arm('p1', ['fala do dono']))
  assert.deepEqual(debt.pending('p1'), ['fala do dono'], 'a dívida em memória se perdeu com o erro de disco')
  assert.doesNotThrow(() => debt.clear('p1'))
  assert.doesNotThrow(() => sweepFlags('C:\\flags', boom))
})

// ————— 7. A VARREDURA DE BOOT —————

test('sweepFlags limpa bandeira órfã de processo morto e devolve a conta', () => {
  const fs = fakeFs()
  fs.write(join('C:\\flags', 'p1.txt'), '{}')
  fs.write(join('C:\\flags', 'p2.txt'), '{}')
  fs.write(join('C:\\flags', 'leia-me.md'), 'nao e bandeira')
  fs.write(join('C:\\outra', 'p3.txt'), '{}')
  const removed = sweepFlags('C:\\flags', fs)
  assert.equal(removed, 2, `varreu ${removed} bandeiras — esperava 2`)
  assert.equal(fs.files.has(join('C:\\flags', 'leia-me.md')), true, 'a varredura comeu arquivo que não é bandeira')
  assert.equal(fs.files.has(join('C:\\outra', 'p3.txt')), true, 'a varredura saiu da pasta que lhe foi dada')
})

test('sweepFlags em pasta que não existe é no-op silencioso', () => {
  assert.doesNotThrow(() => sweepFlags(join(tmpdir(), 'synkora-owner-debt-que-nao-existe-9x')))
})

// ————— 8. O DISCO DE VERDADE (o fs padrão, sem injeção) —————

test('sem fs injetado a dívida usa o disco real, cria a pasta e varre depois', () => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-owner-debt-'))
  const flagDir = join(root, 'owner-debt') // NÃO existe ainda: arm tem que criar
  const debt = new GuiOwnerReplyDebt({ flagDir })
  debt.arm('gui:pane-real', ['para tudo, o dock vem primeiro'])
  const path = guiOwnerDebtFlagPath(flagDir, 'gui:pane-real')
  assert.ok(existsSync(path), 'a bandeira não apareceu no disco')
  assert.match(readFileSync(path, 'utf8'), /permissionDecision/u)
  debt.clear('gui:pane-real')
  assert.equal(existsSync(path), false, 'clear não apagou do disco')

  debt.arm('gui:pane-real', ['de novo'])
  assert.equal(sweepFlags(flagDir), 1, 'a varredura de boot não achou a bandeira órfã')
  assert.deepEqual(readdirSync(flagDir), [], 'sobrou bandeira depois da varredura')
  rmSync(root, { recursive: true, force: true })
})

// ————— 9. O TEXTO DA RECUSA (a lição das SEIS chamadas) —————
//
// O texto velho dizia "ESTA tool só destrava…" e o modelo trocou de tool cinco
// vezes. O novo tem que dizer, sem margem, que TODAS estão bloqueadas — e que
// tentar outra dá na mesma.

test('a recusa diz que TODAS as tools estão bloqueadas, nativas inclusive', () => {
  const text = guiOwnerReplyRefusal(['troca o azul por laranja'])
  assert.match(text, /todas as (suas )?tools/iu, 'a recusa não diz que são TODAS as tools')
  assert.match(text, /nativas/iu, 'a recusa não nomeia as tools NATIVAS')
  assert.match(text, /Synkora/u, 'a recusa não nomeia as tools do Synkora')
  assert.doesNotMatch(text, /\besta tool\b/iu, 'voltou o "esta tool" — foi ele que autorizou trocar de tool')
})

test('a recusa avisa que trocar de tool dá na mesma', () => {
  const text = guiOwnerReplyRefusal(['fala'])
  assert.match(text, /outra tool/iu, 'a recusa não fecha a porta da tool seguinte')
})

test('a recusa nomeia a RECEITA e re-cita a fala do dono', () => {
  const text = guiOwnerReplyRefusal(['troca o azul por laranja'])
  assert.match(text, /uma ou duas linhas/iu, 'sumiu a receita exata')
  assert.match(text, /texto/iu, 'a receita não diz que a saída é TEXTO no chat')
  assert.match(text, /troca o azul por laranja/u, 'a fala do dono não foi re-citada')
})

test('duas falas saem numeradas e a citação tem teto', () => {
  const text = guiOwnerReplyRefusal(['primeira', 'segunda'])
  assert.match(text, /1\. "primeira"/u)
  assert.match(text, /2\. "segunda"/u)
  const huge = guiOwnerReplyRefusal(['x'.repeat(5000)])
  assert.ok(huge.length < 1600, `recusa com ${huge.length} chars — a citação perdeu o teto`)
})
