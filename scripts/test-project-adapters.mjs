import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  detectProjectAdapters,
  isAllowlistedAdapterEvidencePath,
  selectProjectAdapterCommands
} from '../src/main/projectAdapters.ts'

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'synkora-project-adapters-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function write(file, content = '') {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content, 'utf8')
}

function writePackage(root, value) {
  write(join(root, 'package.json'), `${JSON.stringify(value, null, 2)}\n`)
}

function detect(root) {
  return Object.fromEntries(
    detectProjectAdapters({ root }).map((adapter) => [adapter.kind, adapter])
  )
}

function verificationCommand(kind, suffix, overrides = {}) {
  return {
    id: `adapter:${kind}:node:${suffix}`,
    label: `npm run ${suffix}`,
    command: 'npm',
    args: ['run', suffix],
    cwd: 'C:/fixture',
    sourcePath: 'package.json',
    timeoutMs: 120_000,
    ...overrides
  }
}

function adapter(kind, state = 'active', commandNames = ['check']) {
  return {
    kind,
    state,
    evidence: [],
    missingSignals: [],
    verificationCommands: commandNames.map((name) => verificationCommand(kind, name))
  }
}

function select(detections, overrides = {}) {
  return selectProjectAdapterCommands({
    detections,
    mode: 'standard',
    risk: 'low',
    riskSurfaces: [],
    missionText: '',
    maxCommands: 10,
    ...overrides
  })
}

test('pasta vazia deixa todos os módulos opcionais desativados', (t) => {
  const adapters = detect(temporaryRoot(t))
  assert.deepEqual(Object.keys(adapters), [
    'ci',
    'pull_request',
    'security',
    'deploy',
    'web_quality'
  ])
  assert.deepEqual(
    Object.values(adapters).map((adapter) => adapter.state),
    [
      'not_configured',
      'not_configured',
      'not_configured',
      'not_configured',
      'not_configured'
    ]
  )
  assert(Object.values(adapters).every((adapter) => adapter.verificationCommands.length === 0))
})

test('workflow conhecido ativa CI; arquivo arbitrário não entra como evidência', (t) => {
  const root = temporaryRoot(t)
  write(join(root, '.github', 'workflows', 'ci.yml'), 'on: [push]\n')
  write(join(root, 'my-ci-config.txt'), 'ci')
  const adapters = detect(root)
  assert.equal(adapters.ci.state, 'active')
  assert.deepEqual(adapters.ci.evidence, [
    { path: '.github/workflows/ci.yml', signal: 'workflow de CI' }
  ])
  assert(Object.values(adapters).flatMap((item) => item.evidence).every((item) =>
    isAllowlistedAdapterEvidencePath(item.path)
  ))
})

test('PR exige remote e template/configuração ao mesmo tempo', (t) => {
  const templateOnly = temporaryRoot(t)
  write(join(templateOnly, '.github', 'PULL_REQUEST_TEMPLATE.md'), '## Resumo\n')
  assert.equal(detect(templateOnly).pull_request.state, 'not_configured')
  assert.deepEqual(detect(templateOnly).pull_request.missingSignals, ['remote_git'])

  const remoteOnly = temporaryRoot(t)
  write(
    join(remoteOnly, '.git', 'config'),
    '[remote "origin"]\n  url = git@example.test:team/repo.git\n'
  )
  assert.equal(detect(remoteOnly).pull_request.state, 'not_configured')
  assert.deepEqual(detect(remoteOnly).pull_request.missingSignals, ['pr_template_or_config'])

  write(join(remoteOnly, '.github', 'PULL_REQUEST_TEMPLATE', 'feature.md'), '# PR\n')
  const active = detect(remoteOnly).pull_request
  assert.equal(active.state, 'active')
  assert.deepEqual(active.evidence.map((item) => item.path), [
    '.git/config',
    '.github/PULL_REQUEST_TEMPLATE/feature.md'
  ])
})

test('workflow pull_request conta como configuração de PR somente com remote', (t) => {
  const root = temporaryRoot(t)
  write(join(root, '.git', 'config'), '[remote "origin"]\nurl = https://example.test/repo.git\n')
  write(join(root, '.github', 'workflows', 'checks.yaml'), 'on:\n  pull_request:\n')
  const adapter = detect(root).pull_request
  assert.equal(adapter.state, 'active')
  assert(adapter.evidence.some((item) => item.signal.includes('acionado por pull request')))
})

test('reconhece remote de worktree sem expor caminho externo', (t) => {
  const root = temporaryRoot(t)
  const common = temporaryRoot(t)
  const gitDirectory = join(common, 'worktrees', 'mission')
  write(join(root, '.git'), `gitdir: ${gitDirectory}\n`)
  write(join(gitDirectory, 'commondir'), '../..\n')
  write(join(common, 'config'), '[remote "origin"]\nurl = https://example.test/repo.git\n')
  write(join(root, 'CODEOWNERS'), '* @team\n')
  const adapter = detect(root).pull_request
  assert.equal(adapter.state, 'active')
  assert(adapter.evidence.some((item) => item.path === '.git'))
  assert(adapter.evidence.every((item) => !item.path.includes(common)))
})

test('configuração ou script explícito ativa segurança', (t) => {
  const configRoot = temporaryRoot(t)
  write(join(configRoot, '.gitleaks.toml'), '[allowlist]\n')
  assert.equal(detect(configRoot).security.state, 'active')

  const scriptRoot = temporaryRoot(t)
  writePackage(scriptRoot, { scripts: { 'security:check': 'gitleaks detect --redact' } })
  const adapter = detect(scriptRoot).security
  assert.equal(adapter.state, 'active')
  assert.deepEqual(adapter.evidence, [
    { path: 'package.json', signal: 'script de segurança declarado' }
  ])
  assert.deepEqual(adapter.verificationCommands.map((item) => item.id), [
    'adapter:security:node:security:check'
  ])
})

test('segurança reconhece reachability e recusa scanner remoto ou não analisável', (t) => {
  const root = temporaryRoot(t)
  writePackage(root, {
    scripts: {
      'audit:dependency': 'semgrep scan --config .semgrep.yml',
      'check:reachability': 'node --test tests/reachability.test.js',
      'check:cve:auto': 'semgrep scan --config auto',
      'check:cve:remote': 'semgrep scan --config https://example.test/rules.yml',
      'check:osv:download': 'npx osv-scanner scan .',
      'audit:network': 'npm audit'
    }
  })
  const security = detect(root).security
  assert.equal(security.state, 'active')
  assert.deepEqual(security.verificationCommands.map((item) => item.id), [
    'adapter:security:node:audit:dependency',
    'adapter:security:node:check:reachability'
  ])
})

test('web_quality exige UI pública e configuração ou script de qualidade', (t) => {
  const qualityOnly = temporaryRoot(t)
  writePackage(qualityOnly, {
    scripts: { 'test:a11y': 'playwright test tests/a11y.spec.ts' }
  })
  assert.equal(detect(qualityOnly).web_quality.state, 'not_configured')
  assert.deepEqual(detect(qualityOnly).web_quality.missingSignals, ['public_ui'])

  const uiOnly = temporaryRoot(t)
  writePackage(uiOnly, { dependencies: { 'react-dom': '^19.0.0' } })
  assert.equal(detect(uiOnly).web_quality.state, 'not_configured')
  assert.deepEqual(detect(uiOnly).web_quality.missingSignals, [
    'web_quality_script_or_config'
  ])
})

test('web_quality aceita checks locais de a11y, responsividade, motion e SEO', (t) => {
  const root = temporaryRoot(t)
  write(join(root, 'playwright.config.ts'), 'export default {}\n')
  writePackage(root, {
    dependencies: { 'react-dom': '^19.0.0' },
    scripts: {
      'a11y:check:pa11y': 'pa11y http://localhost:4173',
      'audit:seo':
        'lighthouse http://127.0.0.1:4173 --output=json --output-path=stdout',
      'check:responsive': 'playwright test tests/responsive.spec.ts',
      'test:a11y': 'playwright test tests/a11y.spec.ts',
      'test:reduced-motion': 'vitest run tests/motion.test.ts',
      'a11y:check:remote': 'pa11y https://example.test',
      'e2e:check:remote': 'playwright test https://example.test/flow',
      'seo:check:file':
        'lighthouse http://localhost:4173 --output=json --output-path=report.json',
      'seo:check:remote':
        'lighthouse https://example.test --output=json --output-path=stdout',
      'visual:check:update': 'playwright test --update-snapshots'
    }
  })

  const web = detect(root).web_quality
  assert.equal(web.state, 'active')
  assert(web.evidence.some((item) => item.path === 'package.json'))
  assert(web.evidence.some((item) => item.path === 'playwright.config.ts'))
  assert(web.evidence.every((item) => isAllowlistedAdapterEvidencePath(item.path)))
  assert.deepEqual(web.verificationCommands.map((item) => item.id), [
    'adapter:web_quality:node:a11y:check:pa11y',
    'adapter:web_quality:node:audit:seo'
  ])
})

test('hosting explícito ativa deploy, Dockerfile isolado não', (t) => {
  const root = temporaryRoot(t)
  write(join(root, 'Dockerfile'), 'FROM scratch\n')
  assert.equal(detect(root).deploy.state, 'not_configured')
  write(join(root, '.openai', 'hosting.json'), '{}\n')
  assert.equal(detect(root).deploy.state, 'active')
  assert.deepEqual(detect(root).deploy.evidence.map((item) => item.path), [
    '.openai/hosting.json'
  ])
})

test('gera apenas check/validate/verify/dry-run e exclui deploy, publish e release', (t) => {
  const root = temporaryRoot(t)
  write(join(root, 'vercel.json'), '{}\n')
  writePackage(root, {
    scripts: {
      'deploy:check': 'terraform validate',
      'check:deploy': 'terraform fmt -check',
      'deploy:dry-run': 'docker compose config',
      'deploy:validate': 'npm run safe-helper',
      'deploy:verify-release': 'npm run release',
      deploy: 'vercel deploy',
      publish: 'npm publish',
      release: 'node release.js',
      'safe-helper': 'helm lint charts/app'
    }
  })
  write(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  const commands = detect(root).deploy.verificationCommands
  assert.deepEqual(commands.map((item) => item.id), [
    'adapter:deploy:node:check:deploy',
    'adapter:deploy:node:deploy:check',
    'adapter:deploy:node:deploy:dry-run',
    'adapter:deploy:node:deploy:validate'
  ])
  assert(commands.every((item) => item.command === 'pnpm'))
  assert(!commands.some((item) => ['deploy', 'publish', 'release'].includes(item.args[1])))
})

test('recusa script de nome seguro quando corpo ou dependência local é mutante', (t) => {
  const root = temporaryRoot(t)
  write(join(root, 'netlify.toml'), '[build]\n')
  writePackage(root, {
    scripts: {
      'deploy:check': 'npm run hidden-mutation',
      'hidden-mutation': 'netlify deploy --prod',
      'deploy:verify': 'gh pr create --fill',
      'deploy:dry-run': 'npx some-checker',
      'deploy:check:built-in': 'npm publish',
      publish: 'gitleaks detect'
    }
  })
  assert.deepEqual(detect(root).deploy.verificationCommands, [])
})

test('recusa node arbitrário e aceita somente node --check ou node --test', (t) => {
  const root = temporaryRoot(t)
  writePackage(root, {
    scripts: {
      'security:check:custom': 'node verify-security.js',
      'security:check:syntax': 'node --check scripts/security-config.js',
      'security:check:tests': 'node --test test/security.test.js'
    }
  })
  assert.deepEqual(detect(root).security.verificationCommands.map((item) => item.id), [
    'adapter:security:node:security:check:syntax',
    'adapter:security:node:security:check:tests'
  ])
})

test('valida hooks pre/post implícitos e recusa o comando quando qualquer hook é inseguro', (t) => {
  const root = temporaryRoot(t)
  writePackage(root, {
    scripts: {
      'security:check:unsafe-hook': 'gitleaks detect --redact',
      'presecurity:check:unsafe-hook': 'terraform apply',
      'postsecurity:check:unsafe-hook': 'actionlint',
      'security:check:safe-hook': 'gitleaks detect --redact',
      'presecurity:check:safe-hook': 'node --check scripts/config.js',
      'postsecurity:check:safe-hook': 'prettier --check package.json'
    }
  })
  assert.deepEqual(detect(root).security.verificationCommands.map((item) => item.id), [
    'adapter:security:node:security:check:safe-hook'
  ])
})

test('allowlist aceita somente validadores diretos conhecidos e encadeamento seguro', (t) => {
  const root = temporaryRoot(t)
  write(join(root, '.github', 'workflows', 'ci.yml'), 'on: [push]\n')
  const allowed = {
    'ci:check:actionlint': 'actionlint',
    'ci:check:biome': 'biome check .',
    'ci:check:compose': 'docker compose config',
    'ci:check:eslint': 'eslint .',
    'ci:check:gitleaks': 'gitleaks detect --redact',
    'ci:check:helm': 'helm lint charts/app',
    'ci:check:node': 'node --check scripts/config.js',
    'ci:check:prettier': 'prettier --check .',
    'ci:check:recursive': 'npm run readonly-helper',
    'ci:check:semgrep': 'semgrep scan --config .semgrep.yml',
    'ci:check:terraform-fmt': 'terraform fmt -check',
    'ci:check:terraform-validate': 'terraform validate',
    'ci:check:trivy-config': 'trivy config .',
    'ci:check:trivy-fs': 'trivy fs .',
    'ci:check:tsc': 'tsc --noEmit',
    'ci:check:vitest': 'vitest run',
    'readonly-helper': 'eslint . && prettier --check .'
  }
  writePackage(root, { scripts: allowed })
  const detected = detect(root).ci.verificationCommands.map((item) => item.args[1])
  assert.deepEqual(new Set(detected), new Set(Object.keys(allowed).filter((name) => name.startsWith('ci:'))))
})

test('validadores conhecidos continuam recusados quando recebem flags mutantes', (t) => {
  const root = temporaryRoot(t)
  write(join(root, '.github', 'workflows', 'ci.yml'), 'on: [push]\n')
  writePackage(root, {
    scripts: {
      'ci:check:eslint': 'eslint . --fix',
      'ci:check:biome': 'biome check . --write',
      'ci:check:prettier': 'prettier --write .',
      'ci:check:gitleaks': 'gitleaks detect --report-path leaks.json',
      'ci:check:gitleaks-unredacted': 'gitleaks detect',
      'ci:check:semgrep': 'semgrep scan --autofix',
      'ci:check:terraform': 'terraform fmt',
      'ci:check:tsc-false': 'tsc --noEmit false',
      'ci:check:cargo-fix': 'cargo clippy --fix',
      'ci:check:maven-deploy': 'mvn test deploy',
      'ci:check:compose': 'docker compose config --output combined.yml',
      'ci:check:masked-or': 'eslint . || actionlint',
      'ci:check:masked-sequence': 'eslint .; actionlint'
    }
  })
  assert.deepEqual(detect(root).ci.verificationCommands, [])
})

test('recusa expansão de ambiente POSIX, PowerShell e cmd antes de validar argumentos', (t) => {
  const root = temporaryRoot(t)
  write(join(root, '.github', 'workflows', 'ci.yml'), 'on: [push]\n')
  writePackage(root, {
    scripts: {
      'ci:check:safe': 'eslint .',
      'ci:check:posix': 'eslint . $ESLINT_FLAGS',
      'ci:check:posix-braced': 'eslint . ${ESLINT_FLAGS}',
      'ci:check:posix-special': 'eslint . $@',
      'ci:check:powershell': 'eslint . $env:ESLINT_FLAGS',
      'ci:check:cmd': 'eslint . %ESLINT_FLAGS%',
      'ci:check:cmd-delayed': 'eslint . !ESLINT_FLAGS!'
    }
  })
  assert.deepEqual(detect(root).ci.verificationCommands.map((item) => item.id), [
    'adapter:ci:node:ci:check:safe'
  ])
})

test('expansão insegura em pre/post hook invalida o script principal', (t) => {
  const root = temporaryRoot(t)
  writePackage(root, {
    scripts: {
      'security:check': 'gitleaks detect',
      'presecurity:check': 'eslint "$SECURITY_PATH"',
      'postsecurity:check': 'actionlint'
    }
  })
  assert.equal(detect(root).security.state, 'active')
  assert.deepEqual(detect(root).security.verificationCommands, [])
})

test('scripts comuns não ativam módulos nem viram comandos opcionais', (t) => {
  const root = temporaryRoot(t)
  writePackage(root, { scripts: { test: 'vitest run', build: 'vite build', check: 'tsc --noEmit' } })
  const adapters = detect(root)
  assert.equal(adapters.security.state, 'not_configured')
  assert.equal(adapters.deploy.state, 'not_configured')
  assert(Object.values(adapters).every((adapter) => adapter.verificationCommands.length === 0))
})

test('ordem e resultado são determinísticos', (t) => {
  const root = temporaryRoot(t)
  write(join(root, '.github', 'workflows', 'z.yml'), 'on: push\n')
  write(join(root, '.github', 'workflows', 'a.yaml'), 'on: push\n')
  write(join(root, 'azure-pipelines.yml'), 'trigger: [main]\n')
  assert.deepEqual(detectProjectAdapters({ root }), detectProjectAdapters({ root }))
  assert.deepEqual(detect(root).ci.evidence.map((item) => item.path), [
    '.github/workflows/a.yaml',
    '.github/workflows/z.yml',
    'azure-pipelines.yml'
  ])
})

test('seleção nunca usa módulo not_configured nem módulo sem comando seguro', () => {
  assert.deepEqual(
    select(
      [adapter('ci', 'not_configured'), adapter('security', 'active', [])],
      { mode: 'deep', risk: 'high', riskSurfaces: ['security'] }
    ),
    []
  )
})

test('FAST sem risco alto ou superfície explícita não reserva adaptador', () => {
  assert.deepEqual(
    select([adapter('ci'), adapter('security'), adapter('deploy')], {
      mode: 'fast',
      risk: 'medium'
    }),
    []
  )
})

test('FAST de risco alto usa no máximo um módulo e habilita CI', () => {
  const selected = select(
    [adapter('ci', 'active', ['z-check', 'a-check']), adapter('pull_request')],
    { mode: 'fast', risk: 'high', maxCommands: 5 }
  )
  assert.deepEqual(selected.map((item) => item.id), [
    'adapter:ci:node:a-check'
  ])
})

test('FAST reconhece superfícies explícitas e prioriza segurança sobre deploy', () => {
  const selected = select([adapter('ci'), adapter('deploy'), adapter('security')], {
    mode: 'fast',
    risk: 'low',
    riskSurfaces: ['payments', 'infra'],
    maxCommands: 3
  })
  assert.deepEqual(selected.map((item) => item.id), ['adapter:security:node:check'])
  assert.deepEqual(
    select([adapter('security')], {
      mode: 'fast',
      risk: 'low',
      riskSurfaces: ['personal_data']
    }).map((item) => item.id),
    ['adapter:security:node:check']
  )
})

test('STANDARD usa no máximo um módulo e CI entra por padrão proporcional', () => {
  assert.deepEqual(
    select([adapter('pull_request'), adapter('ci')], {
      mode: 'standard',
      missionText: 'abrir PR ao terminar'
    }).map((item) => item.id),
    ['adapter:ci:node:check']
  )
  assert.deepEqual(
    select([adapter('deploy'), adapter('ci')], {
      mode: 'standard',
      riskSurfaces: ['infraestrutura']
    }).map((item) => item.id),
    ['adapter:deploy:node:check']
  )
})

test('web_quality só toma o orçamento quando a missão realmente afeta a interface', () => {
  const detections = [adapter('ci'), adapter('web_quality')]
  assert.deepEqual(
    select(detections, {
      mode: 'standard',
      missionText: 'Ajustar a responsividade da tela pública'
    }).map((item) => item.id),
    ['adapter:web_quality:node:check']
  )
  assert.deepEqual(
    select(detections, {
      mode: 'standard',
      missionText: 'Ajustar o parser interno de configuração'
    }).map((item) => item.id),
    ['adapter:ci:node:check']
  )
  assert.deepEqual(
    select([adapter('web_quality')], {
      mode: 'fast',
      risk: 'low',
      missionText: 'Validar acessibilidade e reduced-motion da página'
    }).map((item) => item.id),
    ['adapter:web_quality:node:check']
  )
})

test('DEEP preserva segurança primeiro e reserva o segundo módulo para UI relevante', () => {
  const selected = select(
    [adapter('ci'), adapter('deploy'), adapter('web_quality'), adapter('security')],
    {
      mode: 'deep',
      risk: 'high',
      riskSurfaces: ['authentication', 'release'],
      missionText: 'Revisar login e responsividade da interface web',
      maxCommands: 10
    }
  )
  assert.deepEqual(selected.map((item) => item.id), [
    'adapter:security:node:check',
    'adapter:web_quality:node:check'
  ])
})

test('PR só é relevante no DEEP ou quando a missão o cita explicitamente', () => {
  assert.deepEqual(select([adapter('pull_request')], { mode: 'standard' }), [])
  assert.deepEqual(
    select([adapter('pull_request')], {
      mode: 'standard',
      missionText: 'Prepare o pull request com o resumo'
    }).map((item) => item.id),
    ['adapter:pull_request:node:check']
  )
  assert.deepEqual(
    select([adapter('pull_request')], { mode: 'deep' }).map((item) => item.id),
    ['adapter:pull_request:node:check']
  )
})

test('DEEP escolhe no máximo dois módulos pela prioridade de relevância', () => {
  const selected = select(
    [adapter('pull_request'), adapter('ci'), adapter('deploy'), adapter('security')],
    {
      mode: 'deep',
      risk: 'high',
      riskSurfaces: ['auth', 'release'],
      maxCommands: 10
    }
  )
  assert.deepEqual(selected.map((item) => item.id), [
    'adapter:security:node:check',
    'adapter:deploy:node:check'
  ])
})

test('DEEP sem superfícies específicas seleciona CI e PR', () => {
  const selected = select(
    [adapter('security'), adapter('deploy'), adapter('pull_request'), adapter('ci')],
    { mode: 'deep' }
  )
  assert.deepEqual(selected.map((item) => item.id), [
    'adapter:ci:node:check',
    'adapter:pull_request:node:check'
  ])
})

test('faz uma rodada por módulo e o próprio seletor impõe o teto proporcional', () => {
  const selected = select(
    [
      adapter('security', 'active', ['security-z', 'security-a']),
      adapter('deploy', 'active', ['deploy-z', 'deploy-a'])
    ],
    {
      mode: 'deep',
      riskSurfaces: ['data-sensitive', 'deploy'],
      maxCommands: 3
    }
  )
  assert.deepEqual(selected.map((item) => item.id), [
    'adapter:security:node:security-a',
    'adapter:deploy:node:deploy-a'
  ])
  assert.deepEqual(select([adapter('ci')], { maxCommands: 0 }), [])
  assert.deepEqual(select([adapter('ci')], { maxCommands: Number.POSITIVE_INFINITY }), [])
})

test('seleção é determinística apesar da ordem de entrada e remove duplicatas', () => {
  const first = adapter('ci', 'active', ['z', 'a'])
  const duplicate = adapter('ci', 'active', ['a'])
  const forward = select([first, duplicate], { mode: 'standard', maxCommands: 10 })
  const reverse = select([duplicate, first], { mode: 'standard', maxCommands: 10 })
  assert.deepEqual(forward, reverse)
  assert.deepEqual(forward.map((item) => item.id), ['adapter:ci:node:a'])
})
