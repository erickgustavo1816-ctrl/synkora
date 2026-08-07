#!/usr/bin/env node
// Cenários 6 + 11 da matriz de falhas (plano de estabilização 02/08/2026), no
// nível Git real: merge de card aprovado BLOQUEADO por destino sujo → branch e
// worktree preservados → reparo do destino (commit da sujeira) → retry do
// MESMO commit aprovado com a fotografia nova do destino → sucesso, sem tocar
// no trabalho. É o contrato que o reparo de integração (run_task
// {phase:"finalize"}) assume do worktree.ts.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  createMissionWorktree,
  createTaskWorktree,
  gitHead,
  gitVisibleWorktreeFingerprint,
  gitLocalBranchExists,
  isWorktreeClean,
  mergeTaskWorktree
} = await import(new URL('../.tmp/merge-repair-test/worktree.js', import.meta.url))
const { immutableReviewDiff } = await import(
  new URL('../.tmp/merge-repair-test/reviewDiff.js', import.meta.url)
)

let passed = 0
function ok(condition, label) {
  assert.ok(condition, label)
  passed += 1
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Probe',
      GIT_AUTHOR_EMAIL: 'probe@synkora.test',
      GIT_COMMITTER_NAME: 'Probe',
      GIT_COMMITTER_EMAIL: 'probe@synkora.test'
    }
  }).trim()
}

const root = mkdtempSync(join(tmpdir(), 'synkora-merge-repair-'))
try {
  const projectPath = join(root, 'project')
  const worktreesDir = join(root, 'worktrees')
  mkdirSync(projectPath, { recursive: true })
  git(projectPath, ['init', '-b', 'master'])
  writeFileSync(join(projectPath, 'app.txt'), 'v1\n', 'utf8')
  git(projectPath, ['add', '.'])
  git(projectPath, ['commit', '-m', 'chore: initial'])

  // missão com branch/worktree próprios
  const missionId = '31acd9bc-test-mission'
  const missionWt = createMissionWorktree(projectPath, worktreesDir, missionId)
  ok(missionWt && gitHead(missionWt.dir), 'worktree da missão criado')

  // card nasce da branch da missão e entrega um commit
  const taskId = 'b6629070-test-task'
  const taskWt = createTaskWorktree(projectPath, worktreesDir, taskId, missionWt.branch)
  ok(taskWt && gitHead(taskWt.dir) === gitHead(missionWt.dir), 'card nasce da missão')
  writeFileSync(join(taskWt.dir, 'app.txt'), 'v2 — entrega aprovada\n', 'utf8')
  git(taskWt.dir, ['add', '.'])
  git(taskWt.dir, ['commit', '-m', 'fix: entrega do card'])
  const approvedHead = gitHead(taskWt.dir)
  const approvedFingerprint = gitVisibleWorktreeFingerprint(taskWt.dir)
  ok(approvedHead && approvedFingerprint, 'fotografia aprovada capturada')

  // cenário 6: destino SUJO no momento do merge
  const missionHeadBefore = gitHead(missionWt.dir)
  writeFileSync(join(missionWt.dir, 'fora-de-card.txt'), 'ajuste manual\n', 'utf8')
  const blocked = mergeTaskWorktree(projectPath, taskWt, 'merge: card aprovado', missionWt.dir, {
    requireCleanSource: true,
    expectedSourceFingerprint: approvedFingerprint,
    expectedSourceHead: approvedHead,
    expectedTargetHead: missionHeadBefore,
    expectedTargetBranch: missionWt.branch
  })
  ok(blocked.ok === false, 'merge com destino sujo é recusado')
  ok(!blocked.committed, 'nada foi commitado no bloqueio')
  ok(/NÃO COMMITADAS/i.test(blocked.detail), 'motivo aponta o destino sujo')
  ok(gitHead(taskWt.dir) === approvedHead, 'commit aprovado intacto após bloqueio')
  ok(gitLocalBranchExists(projectPath, taskWt.branch), 'branch do card preservada')
  ok(gitHead(missionWt.dir) === missionHeadBefore, 'destino não avançou no bloqueio')

  // reparo: o orquestrador (dono da branch da missão) commita a sujeira
  git(missionWt.dir, ['add', '.'])
  git(missionWt.dir, ['commit', '-m', 'chore: enquadrar ajuste fora de card'])
  const missionHeadRepaired = gitHead(missionWt.dir)
  ok(missionHeadRepaired !== missionHeadBefore, 'reparo avançou o destino')
  ok(isWorktreeClean(missionWt.dir) === true, 'destino limpo após reparo')

  // cenário 11: retry do MESMO commit aprovado, com a fotografia NOVA do
  // destino (o retry descarta o receipt "preparing" e recaptura o head)
  const retried = mergeTaskWorktree(projectPath, taskWt, 'merge: card aprovado', missionWt.dir, {
    requireCleanSource: true,
    expectedSourceFingerprint: approvedFingerprint,
    expectedSourceHead: approvedHead,
    expectedTargetHead: missionHeadRepaired,
    expectedTargetBranch: missionWt.branch
  })
  ok(retried.ok === true, `retry pós-reparo integra (${retried.detail})`)
  const log = git(missionWt.dir, ['log', '--oneline', '-5'])
  ok(log.includes('entrega do card'), 'trabalho aprovado presente no destino')
  ok(log.includes('enquadrar ajuste fora de card'), 'reparo preservado no destino')
  ok(!gitLocalBranchExists(projectPath, taskWt.branch), 'branch do card limpa após sucesso')

  // cenário 9 (nível diff): range degenerado produz patch vazio — é o que o
  // guard de entrega vazia impede de chegar a um Reviewer
  const degenerate = immutableReviewDiff(missionWt.dir, missionHeadRepaired, missionHeadRepaired)
  ok(degenerate && /\(vazio\)/.test(degenerate.text), 'base==head → patch explicitamente vazio')
  const real = immutableReviewDiff(missionWt.dir, missionHeadBefore, missionHeadRepaired)
  ok(real && /fora-de-card/.test(real.text), 'range real produz diff com conteúdo')

  console.log(`test-merge-repair: ${passed} assertions ok`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
