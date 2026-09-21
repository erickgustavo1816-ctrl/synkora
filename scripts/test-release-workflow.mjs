import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
const releaseStep = workflow.match(/      - name: Conferir release existente\r?\n([\s\S]*?)(?=\r?\n      - name:)/)?.[1]
assert.ok(releaseStep, 'The release existence check must be present')
const script = releaseStep.split(/        run: \|\r?\n/)[1]?.replace(/^          /gm, '')
assert.ok(script, 'The release check must have a PowerShell run block')

const powershell = ['pwsh', ...(process.platform === 'win32' ? ['powershell.exe'] : [])]
  .find(command => spawnSync(command, ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true }).status === 0)

// GitHub's PowerShell wrapper propagates the last native exit code after the
// run block. Stub only gh's responses; execute the real workflow with that
// wrapper and synthetic inputs, without contacting GitHub or using credentials.
const ghStub = String.raw`
function gh {
  if ($args[0] -eq 'api') {
    if ($env:RELEASE_TEST_CASE -eq 'repository-error') {
      $global:LASTEXITCODE = 1
      Write-Output 'HTTP 403: synthetic repository failure'
    } else {
      $global:LASTEXITCODE = 0
      if ($env:RELEASE_TEST_CASE -eq 'private-repository') {
        Write-Output '{"private":true}'
      } else {
        Write-Output '{"private":false}'
      }
    }
    return
  }
  if ($args[0] -ne 'release' -or $args[1] -ne 'view') {
    throw 'Unexpected gh invocation in workflow regression test'
  }
  if ($env:RELEASE_TEST_CASE -eq 'existing') {
    $global:LASTEXITCODE = 0
    Write-Output '{"tagName":"v0.1.0"}'
  } elseif ($env:RELEASE_TEST_CASE -eq 'missing') {
    $global:LASTEXITCODE = 1
    Write-Output 'release not found'
  } elseif ($env:RELEASE_TEST_CASE -eq 'missing-http') {
    $global:LASTEXITCODE = 1
    Write-Output 'HTTP 404: Not Found'
  } else {
    $global:LASTEXITCODE = 1
    Write-Output 'HTTP 403: synthetic API failure'
  }
}
`

function runCheck(scenario) {
  const temporaryRoot = resolve(tmpdir())
  const directory = mkdtempSync(join(temporaryRoot, 'synkora-release-workflow-'))
  try {
    const scriptPath = join(directory, 'check.ps1')
    const outputPath = join(directory, 'github-output.txt')
    writeFileSync(scriptPath, '\ufeff' + "$ErrorActionPreference = 'Stop'\n" + ghStub + '\n' + script +
      '\nif ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }\n')
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      env: {
        ...process.env,
        GH_TOKEN: scenario === 'missing-token' ? '' : 'synthetic-test-value',
        GITHUB_TOKEN: '',
        GITHUB_OUTPUT: outputPath,
        APP_VERSION: '0.1.0',
        RELEASES_REPO: 'example/synthetic-releases',
        RELEASE_TEST_CASE: scenario
      }
    })
    assert.ifError(result.error)
    const output = existsSync(outputPath) ? readFileSync(outputPath) : Buffer.alloc(0)
    // Windows PowerShell uses UTF-16LE for >>; PowerShell 7 uses UTF-8.
    const text = output.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))
      ? output.toString('utf16le') : output.toString('utf8')
    return { status: result.status, output: text.trim().replace(/^\ufeff/, ''), stderr: result.stderr }
  } finally {
    assert.equal(dirname(resolve(directory)), temporaryRoot)
    assert.ok(basename(directory).startsWith('synkora-release-workflow-'))
    rmSync(directory, { recursive: true, force: true })
  }
}

for (const scenario of ['missing', 'missing-http']) {
  test(`first publication continues when GitHub reports ${scenario}`, { skip: !powershell && 'PowerShell is unavailable' }, () => {
    const result = runCheck(scenario)
    assert.equal(result.status, 0, `The Actions wrapper must accept a missing release: ${result.stderr}`)
    assert.equal(result.output, 'exists=false')
  })
}

test('an existing release is skipped successfully', { skip: !powershell && 'PowerShell is unavailable' }, () => {
  const result = runCheck('existing')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.output, 'exists=true')
})

for (const scenario of ['release-error', 'repository-error', 'private-repository', 'missing-token']) {
  test(`publication remains blocked for ${scenario}`, { skip: !powershell && 'PowerShell is unavailable' }, () => {
    const result = runCheck(scenario)
    assert.notEqual(result.status, 0)
    assert.equal(result.output, '')
  })
}
