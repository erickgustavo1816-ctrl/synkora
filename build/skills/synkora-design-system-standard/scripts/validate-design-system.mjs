import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

const failures = []
const manifestArg = process.argv[2]
const projectRoot = process.cwd()

function fail(message) {
  failures.push(message)
}

function usableString(value) {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('REPLACE_WITH_')
}

function projectPath(value, label) {
  if (!usableString(value)) {
    fail(label + ' must be a filled tracked path')
    return undefined
  }
  const absolute = resolve(projectRoot, value)
  const rel = relative(projectRoot, absolute)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../')) {
    fail(label + ' must stay inside the project')
    return undefined
  }
  if (!existsSync(absolute)) {
    fail(label + ' does not exist: ' + value)
    return undefined
  }
  return absolute
}

if (!manifestArg) {
  fail('usage: node validate-design-system.mjs <manifest.json>')
}

let manifest
if (manifestArg) {
  const file = projectPath(manifestArg, 'manifest')
  if (file) {
    try {
      if (!statSync(file).isFile()) throw new Error('not a file')
      manifest = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      fail('manifest is not readable JSON: ' + (error instanceof Error ? error.message : String(error)))
    }
  }
}

if (manifest) {
  if (manifest.schemaVersion !== 1) fail('schemaVersion must be 1')
  for (const key of ['name', 'version', 'designThesis']) {
    if (!usableString(manifest[key])) fail(key + ' must be filled')
  }

  for (const group of ['tokens', 'components', 'documentation', 'showcase']) {
    const values = manifest.sources && manifest.sources[group]
    if (!Array.isArray(values) || values.length === 0) {
      fail('sources.' + group + ' must contain at least one tracked path')
      continue
    }
    values.forEach((value, index) => projectPath(value, 'sources.' + group + '[' + index + ']'))
  }

  const requiredFoundations = ['color', 'typography', 'spacing', 'radius', 'elevation', 'motion', 'breakpoints']
  const foundations = new Set(Array.isArray(manifest.foundations) ? manifest.foundations : [])
  for (const item of requiredFoundations) {
    if (!foundations.has(item)) fail('foundations is missing ' + item)
  }

  if (!Array.isArray(manifest.componentFamilies) || manifest.componentFamilies.length === 0) {
    fail('componentFamilies must declare at least one real family')
  } else {
    manifest.componentFamilies.forEach((family, index) => {
      const prefix = 'componentFamilies[' + index + ']'
      if (!usableString(family && family.name)) fail(prefix + '.name must be filled')
      projectPath(family && family.source, prefix + '.source')
      if (!Array.isArray(family && family.variants) || family.variants.length === 0) fail(prefix + '.variants must not be empty')
      if (!Array.isArray(family && family.states) || family.states.length === 0) fail(prefix + '.states must not be empty')
      if (!usableString(family && family.accessibility)) fail(prefix + '.accessibility must be filled')
    })
  }

  if (!Array.isArray(manifest.patterns) || manifest.patterns.length === 0) {
    fail('patterns must declare at least one real product pattern')
  } else {
    manifest.patterns.forEach((pattern, index) => {
      const prefix = 'patterns[' + index + ']'
      if (!usableString(pattern && pattern.name)) fail(prefix + '.name must be filled')
      projectPath(pattern && pattern.source, prefix + '.source')
      if (!Array.isArray(pattern && pattern.states) || pattern.states.length === 0) fail(prefix + '.states must not be empty')
    })
  }

  const coverage = manifest.coverage || {}
  if (!Array.isArray(coverage.themes) || coverage.themes.length === 0) fail('coverage.themes must not be empty')
  if (!Array.isArray(coverage.viewports) || coverage.viewports.length < 2) fail('coverage.viewports must include compact and wide evidence')
  for (const item of ['short', 'long', 'empty', 'localized']) {
    if (!Array.isArray(coverage.content) || !coverage.content.includes(item)) fail('coverage.content is missing ' + item)
  }
  for (const state of ['default', 'hover', 'focus-visible', 'disabled', 'loading', 'empty', 'error', 'success']) {
    if (!Array.isArray(coverage.requiredStates) || !coverage.requiredStates.includes(state)) fail('coverage.requiredStates is missing ' + state)
  }

  const accessibility = manifest.accessibility || {}
  for (const key of ['standard', 'keyboard', 'contrast']) {
    if (!usableString(accessibility[key])) fail('accessibility.' + key + ' must be filled')
  }

  const governance = manifest.governance || {}
  for (const key of ['owner', 'versioning', 'deprecationPolicy']) {
    if (!usableString(governance[key])) fail('governance.' + key + ' must be filled')
  }
  projectPath(governance.contributionPath, 'governance.contributionPath')
  projectPath(governance.decisionLogPath, 'governance.decisionLogPath')
}

if (failures.length > 0) {
  console.error('Design-system manifest failed validation:')
  failures.forEach((message) => console.error('- ' + message))
  process.exitCode = 1
} else {
  console.log('Design-system manifest is structurally complete and all declared paths exist.')
}
