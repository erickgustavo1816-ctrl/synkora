import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { cp } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

export type SeatCli = 'claude' | 'codex'

export interface Seat {
  id: string
  name: string
  cli: SeatCli
  createdAt: string
}

export type SeatStatus = 'logado' | 'pendente' | 'expirado'

export interface SeatWithStatus extends Seat {
  status: SeatStatus
  configDir: string
}

// Cada seat é uma conta logada em um CLI, isolada num diretório de config
// próprio (CLAUDE_CONFIG_DIR / CODEX_HOME). O dispatcher (F3) rotaciona seats.
export class SeatStore {
  private file = join(app.getPath('userData'), 'seats.json')
  private seatsRoot = join(app.getPath('userData'), 'seats')
  private seats: Seat[] = []
  private preparations = new Map<string, Promise<void>>()

  constructor() {
    if (existsSync(this.file)) {
      try {
        this.seats = JSON.parse(readFileSync(this.file, 'utf-8'))
      } catch {
        this.seats = []
      }
    }
    // Repara/completa seeds antigos em background. O disco pode trabalhar,
    // mas a janela do app nunca fica bloqueada esperando cópia de executável.
    for (const seat of this.seats) void this.prepare(seat)
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify(this.seats, null, 2), 'utf-8')
  }

  configDirOf(seat: Seat): string {
    return join(this.seatsRoot, seat.id)
  }

  /** Arquivo de credencial do CLI deste seat (heurística de login + mtime). */
  credentialFile(seat: Seat): string {
    const dir = this.configDirOf(seat)
    return seat.cli === 'claude' ? join(dir, '.credentials.json') : join(dir, 'auth.json')
  }

  private statusOf(seat: Seat): SeatStatus {
    // Heurística de login: o CLI grava as credenciais no config dir na
    // primeira autenticação. Se o arquivo não existir, o login está pendente.
    return existsSync(this.credentialFile(seat)) ? 'logado' : 'pendente'
  }

  list(): SeatWithStatus[] {
    return this.seats.map((s) => ({
      ...s,
      status: this.statusOf(s),
      configDir: this.configDirOf(s)
    }))
  }

  get(id: string): Seat | undefined {
    return this.seats.find((s) => s.id === id)
  }

  create(name: string, cli: SeatCli): SeatWithStatus {
    const seat: Seat = { id: randomUUID(), name, cli, createdAt: new Date().toISOString() }
    mkdirSync(this.configDirOf(seat), { recursive: true })
    this.seats.push(seat)
    this.persist()
    // Copiar os artefatos do sandbox Codex pode envolver centenas de MB. Isso
    // nunca deve bloquear o clique em "criar" nem o event loop do Electron.
    // O preparo começa em background e o spawn do terminal aguarda a mesma
    // Promise por `prepare`, sem corrida nem cópia duplicada.
    void this.prepare(seat)
    return { ...seat, status: 'pendente', configDir: this.configDirOf(seat) }
  }

  /** Versão não bloqueante do preseed, coalescida por seat. */
  prepare(seat: Seat): Promise<void> {
    if (seat.cli !== 'codex') return Promise.resolve()
    const running = this.preparations.get(seat.id)
    if (running) return running

    const source = join(homedir(), '.codex')
    const target = this.configDirOf(seat)
    const operation = (async (): Promise<void> => {
      mkdirSync(target, { recursive: true })
      for (const dir of ['.sandbox', '.sandbox-bin', '.sandbox-secrets']) {
        const from = join(source, dir)
        const to = join(target, dir)
        if (!existsSync(from)) continue
        try {
          // `force:false` conserva o que já terminou e completa uma eventual
          // cópia parcial deixada por fechamento do app.
          await cp(from, to, { recursive: true, force: false, errorOnExist: false })
        } catch {
          // Sem os artefatos o Codex tenta o setup normal; melhor tentar do
          // que impedir o seat de abrir.
        }
      }
    })().finally(() => this.preparations.delete(seat.id))

    this.preparations.set(seat.id, operation)
    return operation
  }

  // O Codex no Windows tenta montar o sandbox em todo CODEX_HOME novo e o
  // helper (codex-windows-sandbox-setup.exe) falha em achar a si mesmo — bug
  // conhecido (openai/codex #23194 etc.). Como o sandbox já foi montado uma
  // vez no ~/.codex padrão (e os usuários de sandbox são da máquina, não do
  // diretório), copiamos os artefatos para o seat e o setup é pulado.
  preseed(seat: Seat): void {
    // Compatibilidade para os chamadores que só pedem um best-effort. O
    // trabalho pesado é sempre assíncrono; caminhos que precisam do seed antes
    // do spawn (como pty:create) usam `await prepare(seat)`.
    void this.prepare(seat)
  }

  rename(id: string, name: string): Seat | undefined {
    const seat = this.seats.find((s) => s.id === id)
    if (!seat || !name.trim()) return seat
    seat.name = name.trim()
    this.persist()
    return seat
  }

  // Remove só o registro; o diretório com as credenciais fica preservado
  // (apagar login é decisão do usuário, fora do app).
  remove(id: string): void {
    this.seats = this.seats.filter((s) => s.id !== id)
    this.persist()
  }
}
