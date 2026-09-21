import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// A VERSÃO QUE O PROJETO JÁ TEM (ordem do dono, 2026-09-21): "o Synkora
// deveria ter uma forma de já puxar qual a versão que o projeto está, eu ter
// que colocar manualmente é muito ruim". A pasta do projeto é a main, e o
// `version` do package.json dela é o número que o produto JÁ LANÇOU — a mesma
// chave que o release alinha ao subir (releasePublish). Sem manifesto, sem
// `version` ou com JSON quebrado a resposta é `null`: a tela volta a perguntar
// e nada mais muda. Leitura local de um arquivo pequeno, síncrona de propósito
// (mesma classe da fotografia do release). A leitura do JSON é a MESMA de
// `probeManifestPublish` (releasePublish.ts), sem importá-la: este módulo é
// puro para o teste rodar sem resolver a cadeia de imports do main.

export function manifestVersionFromContents(contents: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const version = (parsed as { version?: unknown }).version
  return typeof version === 'string' && version.length > 0 ? version : null
}

export function readProjectManifestVersion(projectPath: string): string | null {
  try {
    const manifestPath = join(projectPath, 'package.json')
    if (!existsSync(manifestPath)) return null
    return manifestVersionFromContents(readFileSync(manifestPath, 'utf8'))
  } catch {
    return null
  }
}