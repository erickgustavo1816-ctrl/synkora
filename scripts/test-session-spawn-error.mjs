import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'

import {
  isMissingCwdSpawnFailure,
  sessionSpawnFailureText
} from '../src/main/sessionSpawnError.ts'

// A SONDA QUE PROVOU O DIAGNÓSTICO (2026-08-28): no Windows, um `cwd` que não
// existe faz o Node falhar NOMEANDO O EXECUTÁVEL. Sem esta prova a tradução
// seria palpite — e a casa proíbe afirmar protocolo sem sondar em binário real.
test('cwd inexistente falha como se o executável faltasse — o erro do dono, reproduzido', async () => {
  if (process.platform !== 'win32') return
  const erro = await new Promise((resolve) => {
    const filho = spawn(`${process.env.SystemRoot ?? 'C:\WINDOWS'}\system32\cmd.exe`, ['/c', 'echo oi'], {
      cwd: 'C:/pasta/que/nao/existe/synkora-probe'
    })
    filho.on('error', resolve)
  })
  assert.equal(erro.code, 'ENOENT')
  assert.match(erro.message, /cmd\.exe/u, 'o Node culpa o binário; a pasta some da frase')
})

test('o tropeço do cwd sumido é reconhecido — e só ele', () => {
  assert.equal(isMissingCwdSpawnFailure({ code: 'ENOENT', cwdExists: false }), true)
  // binário realmente ausente (a pasta está lá) continua sendo o que é
  assert.equal(isMissingCwdSpawnFailure({ code: 'ENOENT', cwdExists: true }), false)
  assert.equal(isMissingCwdSpawnFailure({ code: 'EACCES', cwdExists: false }), false)
  assert.equal(isMissingCwdSpawnFailure({ cwdExists: false }), false)
})

test('a frase honesta nomeia a pasta e a receita, sem falar em cmd.exe', () => {
  const texto = sessionSpawnFailureText({
    message: 'spawn C:\WINDOWS\system32\cmd.exe ENOENT',
    code: 'ENOENT',
    cwd: 'C:\Users\Erick\AppData\Roaming\synkora\worktrees\p\mission-e8579a6d',
    cwdExists: false
  })
  assert.match(texto, /não existe mais/u)
  assert.match(texto, /mission-e8579a6d/u, 'a pasta é a informação que faltava')
  assert.match(texto, /Reinicie o Synkora/u, 'toda recusa nomeia a receita')
  assert.doesNotMatch(texto, /cmd\.exe/u, 'culpar o cmd.exe era a mentira')
})

test('fora do caso provado a mensagem ORIGINAL passa intacta', () => {
  const cru = 'spawn codex ENOENT'
  assert.equal(
    sessionSpawnFailureText({ message: cru, code: 'ENOENT', cwdExists: true }),
    cru,
    'traduzir um erro que não se entende seria trocar verdade crua por palpite'
  )
  assert.equal(
    sessionSpawnFailureText({ message: 'EPERM qualquer', code: 'EPERM', cwdExists: false }),
    'EPERM qualquer'
  )
})

// ————— A CEIFA POR CAMINHO (mesmo incidente) —————
// O Edge escapou da ceifa por PARENTESCO porque nasceu de uma sessão GUI, fora
// da árvore de um PTY. A régua nova é o CAMINHO — e ela exige as DUAS
// condições, porque cada uma sozinha já produziu um erro real: só o nome seria
// o fratricídio proibido (matar o Chrome do dono); só o caminho mataria a
// própria sonda que menciona a pasta.

test('a régua de caminho reconhece o processo enraizado no worktree', async () => {
  const { processTargetsRoot, VISUAL_PROCESS_NAMES } = await import(
    '../src/main/reapVisualsUnder.ts'
  )
  // caminhos montados sem barra literal: o shell desta sessão come escape
  const B = String.fromCharCode(92)
  const raiz = ['C:', 'wt', 'mission-e8579a6d'].join(B)
  const edge = '"C:' + B + 'Edge' + B + 'msedge.exe" --headless=new --user-data-dir=' +
    raiz + B + '.synkora' + B + 'runs' + B + 'x' + B + 'edge-profile'

  assert.equal(processTargetsRoot(edge, raiz), true)
  // barra trocada é a regra no Windows, e a comparação ignora caixa
  assert.equal(processTargetsRoot(edge.split(B).join("/").toUpperCase(), raiz), true)
  // outro worktree do MESMO projeto nunca entra na conta
  assert.equal(processTargetsRoot(edge, raiz.replace('e8579a6d', 'f5c8fa04')), false)
  assert.equal(processTargetsRoot('', raiz), false)
  assert.equal(processTargetsRoot(edge, '   '), false)

  // a lista é allowlist de app VISUAL — o CLI e os MCP servers ficam intactos
  assert.equal(VISUAL_PROCESS_NAMES.has('msedge.exe'), true)
  assert.equal(VISUAL_PROCESS_NAMES.has('node.exe'), false)
  assert.equal(VISUAL_PROCESS_NAMES.has('codex.exe'), false)
})