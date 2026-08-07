import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

export const SKILL_PACKAGE_SECURITY_VERSION = 1 as const

export type SkillPackageDecision = 'allow' | 'review' | 'block'
export type SkillPackageFindingSeverity = 'review' | 'critical'

export interface SkillPackageFinding {
  id: string
  severity: SkillPackageFindingSeverity
  path: string
  message: string
}

export interface SkillPackageAssessment {
  version: typeof SKILL_PACKAGE_SECURITY_VERSION
  decision: SkillPackageDecision
  fingerprint: string
  filesScanned: number
  findings: SkillPackageFinding[]
  licenseFiles: string[]
}

const MAX_SCAN_FILES = 250
// Alinhado ao teto de download/import da biblioteca: nenhum arquivo aceito
// pode escapar da análise apenas por padding.
const MAX_SCAN_FILE_BYTES = 4 * 1024 * 1024
const MAX_SCAN_TOTAL_BYTES = 30 * 1024 * 1024
const TEXT_FILE = /(?:^|\/)(?:skill\.md|agent\.md|readme|license|copying)(?:\.[a-z0-9]+)?$|\.(?:md|txt|json|jsonc|ya?ml|toml|js|mjs|cjs|ts|tsx|jsx|py|rb|php|go|rs|java|kt|cs|sh|bash|zsh|fish|ps1|cmd|bat)$/i
const LICENSE_FILE = /(?:^|\/)(?:license|licence|copying)(?:\.[a-z0-9]+)?$/i

interface PatternRule {
  id: string
  severity: SkillPackageFindingSeverity
  pattern: RegExp
  message: string
}

const CONTENT_RULES: readonly PatternRule[] = [
  {
    id: 'policy-override',
    // Skills defensivas frequentemente citam o texto de um ataque para
    // reconhecê-lo. O system prompt continua superior; a citação pede revisão,
    // mas não desativa uma skill legítima automaticamente.
    severity: 'review',
    pattern:
      /\b(?:ignore|disregard|override|bypass)\b.{0,80}\b(?:previous|system|developer|security|safety)\b.{0,40}\b(?:instruction|policy|rule|guardrail)s?\b/is,
    message: 'tenta substituir instruções de sistema, segurança ou guardrails'
  },
  {
    id: 'secret-exfiltration',
    severity: 'critical',
    pattern:
      /\b(?:read|open|cat|get-content|collect|find)\b.{0,100}(?:\.env\b|id_rsa\b|\.aws[\\/]credentials|\.ssh[\\/]|private[- ]?key|credentials?\b).{0,180}\b(?:curl|wget|upload|send|post|webhook|exfiltrat|paste)\b/is,
    message: 'combina coleta de credenciais com envio ou exfiltração'
  },
  {
    id: 'download-and-execute',
    severity: 'critical',
    pattern:
      /(?:\bcurl\b[^\r\n|]{0,300}\|\s*(?:sh|bash|zsh|powershell|pwsh)\b|\bwget\b[^\r\n|]{0,300}(?:-O\s*-)?\s*\|\s*(?:sh|bash)|\b(?:iex|invoke-expression)\b.{0,120}\b(?:downloadstring|webclient|invoke-webrequest)\b)/is,
    message: 'baixa conteúdo remoto e o executa diretamente'
  },
  {
    id: 'broad-destruction',
    // Ferramentas de segurança documentam payloads destrutivos como fixtures.
    // A execução continua protegida pelo guard de runtime/human approval.
    severity: 'review',
    pattern:
      /(?:\brm\s+-rf\s+(?:\/|~|\$HOME)\b|\bremove-item\b.{0,120}\b-recurse\b.{0,120}(?:\$home|[a-z]:\\|['"]\/['"])|\bformat\s+[a-z]:|\bdel\s+\/s\s+\/q\s+[a-z]:\\)/is,
    message: 'instrui destruição ampla de diretório, home ou disco'
  },
  {
    id: 'permission-bypass',
    severity: 'review',
    pattern:
      /(?:--dangerously-bypass-approvals-and-sandbox|\bbypasspermissions\b|--no-sandbox|\bskippermissions?\b|\bauto[- ]?approve\b)/i,
    message: 'menciona bypass de sandbox ou aprovação'
  },
  {
    id: 'sensitive-external-effect',
    severity: 'review',
    pattern:
      /\b(?:deploy|publish|release|charge|refund|rotate (?:the )?secret|drop (?:database|table)|force[- ]push|production mutation)\b/i,
    message: 'descreve efeito externo ou irreversível que exige aprovação humana'
  },
  {
    id: 'agent-supply-chain',
    severity: 'review',
    pattern:
      /\b(?:pretooluse|posttooluse|mcpservers?|mcp server|hooks?\s*:|install (?:a )?(?:plugin|skill|extension))\b/i,
    message: 'altera ou amplia a cadeia de ferramentas/agentes'
  }
]

function normalizedPath(root: string, file: string): string | undefined {
  const rel = relative(root, file)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) return undefined
  return rel.replace(/\\/g, '/')
}

function collectTextFiles(root: string): {
  files: Array<{ path: string; file: string }>
  findings: SkillPackageFinding[]
} {
  const absoluteRoot = resolve(root)
  const queue = [absoluteRoot]
  const result: Array<{ path: string; file: string }> = []
  const findings: SkillPackageFinding[] = []
  let totalBytes = 0
  let limitRecorded = false
  while (queue.length > 0) {
    const directory = queue.shift()!
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      findings.push({
        id: 'unreadable-package-path',
        severity: 'critical',
        path: normalizedPath(absoluteRoot, directory) ?? '.',
        message: 'parte do pacote não pôde ser lida para análise'
      })
      continue
    }
    for (const entry of entries) {
      const file = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        queue.push(file)
        continue
      }
      if (!entry.isFile()) continue
      const path = normalizedPath(absoluteRoot, file)
      if (!path || !TEXT_FILE.test(path)) continue
      if (result.length >= MAX_SCAN_FILES) {
        if (!limitRecorded) {
          findings.push({
            id: 'unscanned-file-count',
            severity: 'critical',
            path,
            message: `pacote excede o teto de ${MAX_SCAN_FILES} arquivos de texto analisáveis`
          })
          limitRecorded = true
        }
        continue
      }
      let size = 0
      try {
        const stat = statSync(file)
        size = stat.size
      } catch {
        findings.push({
          id: 'unreadable-package-file',
          severity: 'critical',
          path,
          message: 'arquivo do pacote não pôde ser inspecionado'
        })
        continue
      }
      if (size > MAX_SCAN_FILE_BYTES) {
        findings.push({
          id: 'unscanned-oversized-file',
          severity: 'critical',
          path,
          message: 'arquivo de texto excede o teto seguro de análise'
        })
        continue
      }
      if (totalBytes + size > MAX_SCAN_TOTAL_BYTES) {
        findings.push({
          id: 'unscanned-total-size',
          severity: 'critical',
          path,
          message: 'conteúdo textual do pacote excede o teto total seguro de análise'
        })
        continue
      }
      totalBytes += size
      result.push({ path, file })
    }
  }
  return {
    files: result.sort((left, right) => left.path.localeCompare(right.path, 'en')),
    findings
  }
}

function decisionFor(findings: readonly SkillPackageFinding[]): SkillPackageDecision {
  if (findings.some((finding) => finding.severity === 'critical')) return 'block'
  if (findings.length > 0) return 'review'
  return 'allow'
}

export function assessSkillPackage(directory: string): SkillPackageAssessment {
  const root = resolve(directory)
  const hash = createHash('sha256')
  const findings: SkillPackageFinding[] = []
  const licenseFiles: string[] = []
  const collected = existsSync(root)
    ? collectTextFiles(root)
    : {
        files: [],
        findings: [
          {
            id: 'missing-package-root',
            severity: 'critical' as const,
            path: '.',
            message: 'diretório do pacote não existe'
          }
        ]
      }
  const files = collected.files
  findings.push(...collected.findings)

  for (const candidate of files) {
    let content: Buffer
    try {
      content = readFileSync(candidate.file)
    } catch {
      findings.push({
        id: 'unreadable-package-file',
        severity: 'critical',
        path: candidate.path,
        message: 'arquivo mudou ou deixou de ser legível durante a análise'
      })
      continue
    }
    hash.update(candidate.path).update('\0').update(content).update('\0')
    if (LICENSE_FILE.test(candidate.path)) {
      licenseFiles.push(candidate.path)
      // Licença é texto JURÍDICO, não instrução executável — a MIT contém
      // "publish, distribute, sublicense" e disparava sensitive-external-effect
      // em praticamente TODA skill curada (caso real 2026-08-04: a biblioteca
      // inteira ficou fora dos menus). O arquivo continua no fingerprint.
      continue
    }
    const text = content.toString('utf8')
    for (const rule of CONTENT_RULES) {
      if (!rule.pattern.test(text)) continue
      findings.push({
        id: rule.id,
        severity: rule.severity,
        path: candidate.path,
        message: rule.message
      })
    }
  }

  const unique = new Map<string, SkillPackageFinding>()
  for (const finding of findings) unique.set(`${finding.id}\0${finding.path}`, finding)
  const normalizedFindings = [...unique.values()].slice(0, 40)
  for (const finding of normalizedFindings) {
    hash.update(finding.id).update('\0').update(finding.path).update('\0')
  }
  return {
    version: SKILL_PACKAGE_SECURITY_VERSION,
    decision: decisionFor(normalizedFindings),
    fingerprint: hash.digest('hex'),
    filesScanned: files.length,
    findings: normalizedFindings,
    licenseFiles
  }
}

export function skillPackageBlockMessage(assessment: SkillPackageAssessment): string | undefined {
  if (assessment.decision !== 'block') return undefined
  const visible = assessment.findings
    .filter((finding) => finding.severity === 'critical')
    .slice(0, 3)
    .map((finding) => `${finding.id} em ${finding.path}`)
    .join('; ')
  return `pacote bloqueado pela análise local de supply chain: ${visible || 'sinal crítico'}`
}
