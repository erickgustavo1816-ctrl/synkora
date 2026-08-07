// Sonda 2026-08-02: PowerShell expandindo $env:VAR como argumento de exe
// nativo re-atinge o limite de 32767 chars do CreateProcess (lpCommandLine)
// na camada PS->filho — exatamente o mecanismo que o -EncodedCommand tinha
// resolvido na camada node->PS (pty.ts). Hipótese: persona de missão
// (missionPersona ~27KB + goal 4,5KB) estoura o teto e o pane morre em
// ~280ms com erro 206 (ERROR_FILENAME_EXCED_RANGE), causando o loop de
// respawn visto na missão "Link bonito no WhatsApp" (7e1a1295).
// Uso: node scripts/probe-argv-limit.mjs
import { spawnSync } from 'node:child_process'

const SIZES = [20000, 27000, 30000, 31000, 31500, 32000, 32500, 33000, 36000]

// Mesmo shape do pty.ts: powershell -NoLogo -ExecutionPolicy Bypass
// -EncodedCommand <base64 utf16le do comando>, payload em env var expandida
// pelo PS na hora ($env:SYNKORA_SYSPROMPT). O filho é node (exe nativo, como
// o claude.ps1 -> node da vida real, uma camada a menos).
// Sem aspas duplas no script: PS 5.1 não escapa `"` embutida ao repassar a
// exe nativo (a pegadinha documentada no pty.ts) e o eval quebrava.
const CHILD_SCRIPT = 'console.log(process.argv[1].length)'

for (const size of SIZES) {
  const payload = 'x'.repeat(size)
  const command = `node -e '${CHILD_SCRIPT}' $env:SYNKORA_SYSPROMPT`
  const t0 = Date.now()
  const r = spawnSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(command, 'utf16le').toString('base64')
    ],
    {
      env: { ...process.env, SYNKORA_SYSPROMPT: payload },
      encoding: 'utf8',
      timeout: 30000
    }
  )
  const ms = Date.now() - t0
  const out = (r.stdout ?? '').trim().split('\n').filter(Boolean).at(-1) ?? ''
  // stderr do PS 5.1 vem serializado em CLIXML — decodifica o texto útil.
  let err = (r.stderr ?? '').trim()
  if (err.startsWith('#< CLIXML')) {
    const m = [...err.matchAll(/<S S="Error">([^<]*)<\/S>/g)].map((x) => x[1]).join(' ')
    err = m.replace(/_x000D__x000A_/g, ' ').trim() || err
  }
  err = err.split('\n').find(Boolean) ?? ''
  console.log(
    `payload=${size} exit=${r.status} ${ms}ms out="${out.slice(0, 60)}" err="${err.slice(0, 110)}"`
  )
}
