/**
 * PODA DA BIBLIOTECA (Skills 2.0 — ADR-0007).
 *
 * A curadoria fechou em 16 skills e a lib do dono tem ~400 pastas instaladas
 * na era F6. A poda apaga do DISCO tudo que não é citado por NENHUM kit —
 * e "citado" inclui o slot DESLIGADO: desligar uma ocasião não é autorizar
 * apagar a skill (a proteção é `allKitSkillIds`, não `kitForChat`).
 *
 * REGRAS QUE VALEM COMO CONTRATO:
 * - Roda SÓ por gesto explícito do dono (IPC da tela, com confirmação por
 *   overlay). Nada de poda automática no boot — nenhum caminho deste módulo é
 *   chamado por relógio, watcher ou reconciliador.
 * - O manifest.json perde só as entradas das pastas que saíram; o resto do
 *   arquivo viaja intacto. Manifest ilegível NÃO é sobrescrito: a poda do
 *   disco acontece e a limpeza do registro fica pendente, com sinal.
 * - Pasta que se recusa a sair (arquivo preso no Windows) conta como MANTIDA
 *   e vira sinal — a poda nunca mente sobre o que apagou.
 */
import { readdirSync, rmSync } from 'fs'
import { join, resolve, sep } from 'path'
import { allKitSkillIds, type SkillsKitSignal, type SkillsKitState } from './skillsKit'
import {
  readSkillsManifest,
  skillsBaseDir,
  skillsLibraryRoot,
  skillsManifestFile,
  writeSkillsManifest
} from './skillsLibraryScan'

export interface SkillsPruneResult {
  /** pastas apagadas da lib */
  removed: string[]
  /** pastas preservadas (citadas por algum kit, ou que não saíram) */
  kept: string[]
}

export interface SkillsPruneOptions {
  /** raiz de `skills/` (as suítes apontam para um temporário) */
  base?: string
  /** caixa-preta: o que não saiu e o registro que ficou pendente */
  record?: (signal: SkillsKitSignal) => void
}

/** Uma pasta de skill nunca sai da lib — caminho é dado, não autoridade. */
function insideLibrary(libRoot: string, name: string): string | null {
  const target = resolve(libRoot, name)
  const root = resolve(libRoot)
  if (!target.startsWith(root + sep)) return null
  return target
}

export function pruneSkillsLibrary(
  kit: SkillsKitState,
  options: SkillsPruneOptions = {}
): SkillsPruneResult {
  const base = options.base ?? skillsBaseDir()
  const libRoot = skillsLibraryRoot(base)
  const protectedIds = allKitSkillIds(kit)
  const signal = options.record ?? ((): void => {})

  let names: string[]
  try {
    names = readdirSync(libRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch {
    // lib inexistente: nada a podar (e nada a lamentar)
    return { removed: [], kept: [] }
  }

  const removed: string[] = []
  const kept: string[] = []
  for (const name of names) {
    if (protectedIds.has(name)) {
      kept.push(name)
      continue
    }
    const target = insideLibrary(libRoot, name)
    if (!target) {
      kept.push(name)
      signal({
        event: 'skills-prune-refused',
        reason: 'nome de pasta escaparia da biblioteca',
        detail: { id: name }
      })
      continue
    }
    try {
      rmSync(target, { recursive: true, force: true })
      removed.push(name)
    } catch (error) {
      kept.push(name)
      signal({
        event: 'skills-prune-failed',
        reason: error instanceof Error ? error.message : String(error),
        detail: { id: name }
      })
    }
  }

  if (removed.length > 0) {
    const manifestFile = skillsManifestFile(base)
    const read = readSkillsManifest(manifestFile)
    if (!read.ok) {
      signal({
        event: 'skills-prune-manifest-unreadable',
        reason: 'as pastas saíram, mas o manifest ilegível não foi sobrescrito',
        detail: { removed: removed.length }
      })
    } else {
      const installed = { ...read.manifest.installed }
      const updates = read.manifest.updates ? { ...read.manifest.updates } : undefined
      let dirty = false
      for (const id of removed) {
        if (id in installed) {
          delete installed[id]
          dirty = true
        }
        if (updates && id in updates) {
          delete updates[id]
          dirty = true
        }
      }
      if (dirty) {
        const manifest = { ...read.manifest, installed }
        if (updates) manifest.updates = updates
        writeSkillsManifest(manifest, manifestFile)
      }
    }
  }

  return { removed: removed.sort(), kept: kept.sort() }
}
