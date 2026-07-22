import { app } from 'electron'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
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

export type SeatStatus = 'logado' | 'pendente'

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

  constructor() {
    if (existsSync(this.file)) {
      try {
        this.seats = JSON.parse(readFileSync(this.file, 'utf-8'))
      } catch {
        this.seats = []
      }
    }
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify(this.seats, null, 2), 'utf-8')
  }

  configDirOf(seat: Seat): string {
    return join(this.seatsRoot, seat.id)
  }

  private statusOf(seat: Seat): SeatStatus {
    const dir = this.configDirOf(seat)
    // Heurística de login: o CLI grava as credenciais no config dir na
    // primeira autenticação. Se o arquivo não existir, o login está pendente.
    const credFile =
      seat.cli === 'claude' ? join(dir, '.credentials.json') : join(dir, 'auth.json')
    return existsSync(credFile) ? 'logado' : 'pendente'
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
    this.preseed(seat)
    this.seats.push(seat)
    this.persist()
    return { ...seat, status: 'pendente', configDir: this.configDirOf(seat) }
  }

  // O Codex no Windows tenta montar o sandbox em todo CODEX_HOME novo e o
  // helper (codex-windows-sandbox-setup.exe) falha em achar a si mesmo — bug
  // conhecido (openai/codex #23194 etc.). Como o sandbox já foi montado uma
  // vez no ~/.codex padrão (e os usuários de sandbox são da máquina, não do
  // diretório), copiamos os artefatos para o seat e o setup é pulado.
  preseed(seat: Seat): void {
    if (seat.cli !== 'codex') return
    const source = join(homedir(), '.codex')
    const target = this.configDirOf(seat)
    for (const dir of ['.sandbox', '.sandbox-bin', '.sandbox-secrets']) {
      const from = join(source, dir)
      const to = join(target, dir)
      if (existsSync(from) && !existsSync(to)) {
        try {
          cpSync(from, to, { recursive: true })
        } catch {
          // Sem os artefatos o Codex tenta o setup normal; melhor tentar do
          // que impedir o seat de abrir.
        }
      }
    }
  }

  // Remove só o registro; o diretório com as credenciais fica preservado
  // (apagar login é decisão do usuário, fora do app).
  remove(id: string): void {
    this.seats = this.seats.filter((s) => s.id !== id)
    this.persist()
  }
}
