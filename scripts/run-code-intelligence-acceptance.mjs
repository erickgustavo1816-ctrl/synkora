#!/usr/bin/env node

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileCodeIntelligence, run } from './code-intelligence-compile.mjs'

const buildDir = await mkdtemp(join(tmpdir(), 'synkora-code-intelligence-test-'))
try {
  const version = await compileCodeIntelligence(buildDir, ['acceptance.test.ts'])
  process.stdout.write(`TypeScript ${version} · module/moduleResolution Node16\n`)
  await run(process.execPath, ['--test', join(buildDir, 'acceptance.test.js')])
} finally {
  await rm(buildDir, { recursive: true, force: true })
}
