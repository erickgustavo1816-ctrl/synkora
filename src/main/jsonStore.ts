import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'

function atomicWrite(file: string, content: string): void {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  try {
    writeFileSync(temporary, content, 'utf8')
    renameSync(temporary, file)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // temporário nunca criado ou já promovido
    }
    throw error
  }
}

export function persistJsonStore<T>(file: string, value: T): void {
  const serialized = `${JSON.stringify(value, null, 2)}\n`
  // O JSON principal é o commit; o backup é uma cópia reparável da mesma
  // fotografia. Uma queda nunca deixa um arquivo parcialmente sobrescrito.
  atomicWrite(file, serialized)
  try {
    atomicWrite(`${file}.bak`, serialized)
  } catch {
    // Derivado reparável no próximo load; o commit principal já é válido.
  }
}

export function loadJsonStore<T>(
  file: string,
  fallback: () => T,
  validate: (value: unknown) => value is T
): T {
  const backup = `${file}.bak`
  for (const candidate of [file, backup]) {
    if (!existsSync(candidate)) continue
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, 'utf8'))
      if (!validate(parsed)) continue
      // Repara tanto o principal quanto o backup a partir da fotografia válida.
      try {
        persistJsonStore(file, parsed)
      } catch {
        // A leitura válida continua útil; a próxima persistência tenta de novo.
      }
      return parsed
    } catch {
      // tenta a outra fotografia
    }
  }
  return fallback()
}
