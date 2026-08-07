#!/usr/bin/env node

import assert from 'node:assert/strict'

if (Number(process.versions.node.split('.')[0]) < 24) {
  throw new Error('Node 24+ is required for TypeScript type stripping')
}

const {
  containsSensitiveValue,
  isSensitiveEnvironmentKey,
  isSensitiveKey,
  redactPersistedValue,
  redactSensitiveStrings,
  redactSensitiveText,
  StreamingSensitiveRedactor,
  sanitizedPaneEnvironment
} = await import(new URL('../.tmp/security-redaction-test/securityRedaction.js', import.meta.url))

let passed = 0
const ok = (condition, label) => {
  assert.ok(condition, label)
  passed += 1
}

const examples = [
  ['Authorization: Bearer abcdefghijklmnop', 'abcdefgh', '[redigido:autorizacao]'],
  ['Authorization: Digest username="admin", response="private"', 'private', '[redigido:autorizacao]'],
  ['Proxy-Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcj', '[redigido:autorizacao]'],
  ['Cookie: session=real-cookie-value; theme=dark', 'real-cookie', '[redigido:cookie]'],
  ['Set-Cookie: sid=real-cookie-value; HttpOnly', 'real-cookie', '[redigido:cookie]'],
  ['https://alice:p%40ss@example.test/private?q=1', 'alice', '[redigido:credencial-url]'],
  ['ssh://deploy@example.test/repository', 'deploy', '[redigido:credencial-url]'],
  ['apiKey="a-secret-value-that-must-go"', 'a-secret-value', '[redigido:campo]'],
  ['SYNKORA_TOKEN="a quoted secret with spaces"', 'quoted secret', '[redigido:campo]'],
  ['--access-token command-line-secret', 'command-line-secret', '[redigido:campo]'],
  [
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
    'eyJhbGci',
    '[redigido:jwt]'
  ],
  [
    'eyJhbGciOiJub25lIn0.eyJzdWIiOiJzZW5zaXRpdmUifQ.',
    'eyJhbGci',
    '[redigido:jwt]'
  ],
  ['ghp_abcdefghijklmnopqrstuvwxyz1234567890', 'ghp_', '[redigido:token]'],
  ['whsec_abcdefghijklmnopqrstuvwxyz1234567890', 'whsec_', '[redigido:token]'],
  ['hf_abcdefghijklmnopqrstuvwxyz1234567890', 'hf_', '[redigido:token]'],
  ['sk-ant-abcdefghijklmnopqrstuvwxyz123456', 'sk-ant-', '[redigido:token]'],
  [
    '-----BEGIN PRIVATE KEY-----\nTOPSECRETKEYDATA\n-----END PRIVATE KEY-----',
    'TOPSECRETKEYDATA',
    '[redigido:chave-privada]'
  ]
]

for (const [input, secretFragment, marker] of examples) {
  const output = redactSensitiveText(input)
  ok(!output.includes(secretFragment), `remove ${secretFragment}`)
  ok(output.includes(marker), `marca ${marker}`)
  ok(redactSensitiveText(output) === output, `idempotente para ${marker}`)
}

ok(isSensitiveKey('openrouterKey'), 'provider key camelCase')
ok(isSensitiveKey('database_url'), 'database URL')
ok(isSensitiveKey('nested.authorization'), 'authorization aninhada')
ok(!isSensitiveKey('monkey'), 'monkey não é key secreta')
ok(!isSensitiveKey('tokenizer'), 'tokenizer não é token')
ok(!isSensitiveKey('keyboardKey'), 'keyboard key não é segredo')

const nestedSecret = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890'
const nested = redactPersistedValue({
  apiKey: 'plain-secret',
  message: `falhou usando ${nestedSecret}`,
  nested: { password: 'hidden', safe: 'continua útil' }
})
ok(nested.apiKey === '[redigido:campo]', 'campo sensível redigido')
ok(!nested.message.includes(nestedSecret), 'token em campo de texto redigido')
ok(nested.nested.password === '[redigido:campo]', 'campo sensível profundo redigido')
ok(nested.nested.safe === 'continua útil', 'texto seguro preservado')

const cyclic = { safe: 'ok' }
cyclic.self = cyclic
ok(redactPersistedValue(cyclic).self === '[ciclo]', 'ciclo não derruba o redator')

const inherited = {
  PATH: 'C:\\Windows\\System32',
  LANG: 'pt_BR.UTF-8',
  HTTPS_PROXY: 'https://proxy.example.test:8443',
  OPENAI_API_KEY: 'sk-abcdefghijklmnopqrstuvwxyz123456',
  GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
  AWS_PROFILE: 'production',
  DATABASE_URL: 'postgres://user:pass@db.example.test/app',
  SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
  INNOCENT_WITH_SECRET_VALUE: 'Bearer abcdefghijklmnop',
  UNDEFINED_VALUE: undefined
}
const child = sanitizedPaneEnvironment(inherited, {
  CODEX_HOME: 'C:\\runtime\\codex',
  SYNKORA_TOKEN: 'backend-generated-secret',
  'INVALID-NAME': 'ignored',
  INVALID_NUL: 'ignored\0value'
})
ok(child.PATH === inherited.PATH && child.LANG === inherited.LANG, 'ambiente operacional preservado')
ok(child.HTTPS_PROXY === inherited.HTTPS_PROXY, 'proxy sem credencial preservado')
for (const denied of [
  'OPENAI_API_KEY',
  'GITHUB_TOKEN',
  'AWS_PROFILE',
  'DATABASE_URL',
  'SSH_AUTH_SOCK',
  'INNOCENT_WITH_SECRET_VALUE'
]) {
  ok(!(denied in child), `${denied} não herdada`)
}
ok(child.CODEX_HOME === 'C:\\runtime\\codex', 'runtime explícito preservado')
ok(child.SYNKORA_TOKEN === 'backend-generated-secret', 'token escopado explícito preservado')
ok(!('INVALID-NAME' in child) && !('INVALID_NUL' in child), 'extras inválidos recusados')
ok(isSensitiveEnvironmentKey('NODE_AUTH_TOKEN'), 'token npm reconhecido por nome')
ok(containsSensitiveValue('https://user:pass@example.test'), 'credencial em URL reconhecida')
ok(!containsSensitiveValue('https://example.test/path'), 'URL operacional não é segredo')

const splitToken = new StreamingSensitiveRedactor()
const splitTokenOutput = [
  splitToken.push('inicio token=ghp_abcdefghij'),
  splitToken.push('klmnopqrstuvwxyz1234567890'),
  splitToken.push('\r\nfim')
].join('')
ok(!splitTokenOutput.includes('abcdefghijkl'), 'token entre chunks nao chega ao renderer')
ok(splitTokenOutput.includes('[redigido:token]'), 'token entre chunks recebe marcador')
ok(splitTokenOutput.includes('inicio ') && splitTokenOutput.includes('fim'), 'texto vizinho preservado')

const splitHeader = new StreamingSensitiveRedactor()
const splitHeaderOutput = [
  splitHeader.push('Authorization'),
  splitHeader.push(': Bearer abcdef'),
  splitHeader.push('ghijklmnop\nproxima')
].join('')
ok(!splitHeaderOutput.includes('abcdefghijklmnop'), 'header dividido nao vaza')
ok(splitHeaderOutput.includes('[redigido:'), 'header dividido marcado')

const splitPrivateKey = new StreamingSensitiveRedactor()
const splitPrivateOutput = [
  splitPrivateKey.push('antes\n-----BEGIN PRIVATE KEY-----\nTOP'),
  splitPrivateKey.push('SECRETKEYDATA\n-----END PRIVATE KEY-----'),
  splitPrivateKey.push('\ndepois')
].join('')
ok(!splitPrivateOutput.includes('TOPSECRETKEYDATA'), 'chave privada entre chunks nao vaza')
ok(splitPrivateOutput.includes('[redigido:chave-privada]'), 'chave privada dividida marcada')

const incomplete = new StreamingSensitiveRedactor()
const incompleteOutput = incomplete.push('Bearer curto') + incomplete.finish()
ok(!incompleteOutput.includes('curto'), 'candidato incompleto descartado no exit')
ok(incompleteOutput.includes('[redigido:token]'), 'exit de candidato deixa marcador')

const ordinaryStream = new StreamingSensitiveRedactor()
ok(
  ordinaryStream.push('\x1b[32mcompilacao ok\x1b[0m\r\n') ===
    '\x1b[32mcompilacao ok\x1b[0m\r\n',
  'saida TUI comum permanece byte a byte'
)

const ordinaryUrlStream = new StreamingSensitiveRedactor()
ok(
  ordinaryUrlStream.push('Open https://example.com') === 'Open https://example.com',
  'URL comum sem credencial aparece sem esperar newline'
)

const splitCredentialUrl = new StreamingSensitiveRedactor()
const splitCredentialUrlOutput =
  splitCredentialUrl.push('Open https://alice:se') +
  splitCredentialUrl.push('cret@example.test/path\r\n')
ok(!splitCredentialUrlOutput.includes('alice:secret'), 'credencial em URL dividida nao vaza')
ok(splitCredentialUrlOutput.includes('[redigido:credencial-url]'), 'URL dividida recebe marcador')

const terminatedToken = new StreamingSensitiveRedactor()
const terminatedOutput = terminatedToken.push('token=ghp_abcdefghijklmnopqrstuvwxyz1234567890\r\n')
ok(terminatedOutput.includes('[redigido:token]'), 'newline libera imediatamente um token redigido')
ok(terminatedToken.finish() === '', 'newline nao deixa candidato pendente')

const coloredSecret = redactSensitiveText('password=hidden-value\x1b[0m normal')
ok(!coloredSecret.includes('hidden-value'), 'valor colorido continua redigido')
ok(coloredSecret.includes('\x1b[0m normal'), 'reset ANSI nao e engolido pelo redator ao vivo')

const domainValue = redactSensitiveStrings({
  title: 'manter este texto completo',
  nested: { note: 'apiKey="a-secret-value-that-must-go"', count: 2 },
  items: ['normal', 'Authorization: Bearer abcdefghijklmnop']
})
ok(domainValue.title === 'manter este texto completo', 'store preserva texto comum')
ok(domainValue.nested.count === 2, 'store preserva estrutura e tipos')
ok(
  !JSON.stringify(domainValue).includes('a-secret-value-that-must-go') &&
    !JSON.stringify(domainValue).includes('abcdefghijklmnop'),
  'store redige segredos aninhados sem truncar o contrato'
)

console.log(`test-security-redaction: ${passed} assertions ok`)
