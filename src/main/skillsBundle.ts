/** The installer supplies a starter library; existing owner entries always win. */
import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import type { BlackboxEventInput } from './blackbox'
import { allKitSkillIds, isSkillId, skillsKitStore } from './skillsKit'
import {
  readSkillsManifest,
  SKILLS_MANIFEST_UNREADABLE,
  skillsLibraryRoot,
  skillsManifestFile,
  writeSkillsManifest
} from './skillsLibraryScan'

export interface BundledSkillsInput {
  bundleRoot: string
  libraryRoot: string
  manifestFile: string
  kitIds: readonly string[]
  now?: () => number
}

export interface BundledSkillsResult {
  seeded: string[]
  skipped: string[]
  failures: { id: string; error: string }[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bundleProvenance(bundleRoot: string, id: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(bundleRoot, 'BUNDLE.json'), 'utf8'))
  } catch {
    throw new Error('BUNDLE.json não está legível — reinstale o app para restaurar o pacote de skills')
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.skills)) {
    throw new Error('BUNDLE.json tem formato inválido — reinstale o app para restaurar o pacote de skills')
  }
  const entry = parsed.skills[id]
  if (entry === undefined) return {}
  if (!isRecord(entry) || (entry.sha !== undefined && typeof entry.sha !== 'string')) {
    throw new Error('a procedência da skill no BUNDLE.json é inválida — reinstale o app')
  }
  return entry
}

/** Check before the first write and again in cpSync's filter, never following links. */
function assertCopyable(path: string): void {
  const entry = lstatSync(path)
  if (entry.isSymbolicLink()) {
    throw new Error('o pacote contém link simbólico — reinstale o app com a pasta original da skill')
  }
  if (!entry.isDirectory() && !entry.isFile()) {
    throw new Error('o pacote contém arquivo especial — reinstale o app com a pasta original da skill')
  }
}

function inspectTree(path: string): void {
  assertCopyable(path)
  if (lstatSync(path).isDirectory()) {
    for (const name of readdirSync(path)) inspectTree(join(path, name))
  }
}

function failureText(error: unknown): string {
  // Filesystem messages carry absolute owner paths; only their codes belong in the diary.
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : undefined
  if (code) return `falha de acesso (${code}) — confira as permissões da biblioteca em Ajustes › Skills`
  return error instanceof Error ? error.message : 'não foi possível preparar a biblioteca — confira Ajustes › Skills'
}

/** Node-only core: all filesystem locations and the clock are supplied by the caller. */
export function seedBundledSkills(input: BundledSkillsInput): BundledSkillsResult {
  const result: BundledSkillsResult = { seeded: [], skipped: [], failures: [] }
  for (const id of new Set(input.kitIds)) {
    let created: string | undefined
    try {
      if (!isSkillId(id)) throw new Error('id de skill inválido — revise o kit em Ajustes › Skills')
      const destination = join(input.libraryRoot, id)
      // lstat also sees dangling links, which are still the owner's property.
      if (lstatSync(destination, { throwIfNoEntry: false })) {
        result.skipped.push(id)
        continue
      }
      const source = join(input.bundleRoot, id)
      if (!lstatSync(source, { throwIfNoEntry: false })) {
        result.failures.push({ id, error: 'não está no pacote do app' })
        continue
      }
      assertCopyable(input.bundleRoot)
      inspectTree(source)
      if (!lstatSync(source).isDirectory()) {
        throw new Error('a skill do pacote não é uma pasta — reinstale o app')
      }
      const provenance = bundleProvenance(input.bundleRoot, id)
      const current = readSkillsManifest(input.manifestFile)
      if (!current.ok || Array.isArray(current.manifest.installed)) {
        throw new Error(SKILLS_MANIFEST_UNREADABLE)
      }
      const entry = {
        ...provenance,
        // House skills have no upstream revision; an empty sha matches the manifest contract.
        sha: typeof provenance.sha === 'string' ? provenance.sha : '',
        installedAt: new Date((input.now ?? Date.now)()).toISOString(),
        origin: 'bundle'
      }
      mkdirSync(input.libraryRoot, { recursive: true })
      mkdirSync(dirname(input.manifestFile), { recursive: true })
      try {
        // Claim this new directory exclusively; do not merge with an entry created meanwhile.
        mkdirSync(destination)
      } catch (error) {
        if (isRecord(error) && error.code === 'EEXIST') {
          result.skipped.push(id)
          continue
        }
        throw error
      }
      created = destination
      cpSync(source, destination, {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
        filter: (path) => { assertCopyable(path); return true }
      })
      writeSkillsManifest({
        ...current.manifest,
        installed: { ...current.manifest.installed, [id]: entry }
      }, input.manifestFile)
      created = undefined
      result.seeded.push(id)
    } catch (error) {
      let message = failureText(error)
      if (created) {
        try {
          // Roll back only the directory claimed by this attempt, contained in the supplied root.
          if (relative(resolve(input.libraryRoot), resolve(created)) !== id || lstatSync(created).isSymbolicLink()) {
            throw new Error('a pasta mudou durante a cópia')
          }
          rmSync(created, { recursive: true, force: true })
        } catch {
          message += '; cópia incompleta preservada — confira a skill em Ajustes › Skills'
        }
      }
      result.failures.push({ id, error: message })
    }
  }
  return result
}

export function bundledSkillsRoot(packaged: boolean, resourcesPath: string, appPath: string): string {
  return packaged ? join(resourcesPath, 'skills') : join(appPath, 'build', 'skills')
}

/** Call after boot stores are ready, before registering/spawning any GUI pane. Never throws. */
export function seedBundledSkillsAtBoot(record: (event: BlackboxEventInput) => void): void {
  let result: BundledSkillsResult = { seeded: [], skipped: [], failures: [] }
  try {
    // Resolve Electron only at this boundary; importing the core in node needs no app lifecycle.
    const { app } = require('electron') as typeof import('electron')
    result = seedBundledSkills({
      bundleRoot: bundledSkillsRoot(app.isPackaged, process.resourcesPath, app.getAppPath()),
      libraryRoot: skillsLibraryRoot(),
      manifestFile: skillsManifestFile(),
      kitIds: [...allKitSkillIds(skillsKitStore().state())]
    })
  } catch {
    result.failures.push({ id: 'skills', error: 'não foi possível preparar o pacote no início — confira Ajustes › Skills ou reinstale o app' })
  }
  try {
    record({
      cat: 'app',
      event: 'skills-bundle-seed',
      actor: 'harness',
      detail: { seeded: result.seeded, skipped: result.skipped.length, failures: result.failures }
    })
  } catch {
    // A broken diary must not block app startup either.
  }
}
