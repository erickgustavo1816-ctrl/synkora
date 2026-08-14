const USAGE_LIMIT_LINE = /^\s*Claude AI usage limit reached\|([0-9]+)\s*$/iu
const SAO_PAULO_TIME_ZONE = 'America/Sao_Paulo'

interface UsageDateParts {
  year: number
  month: number
  day: number
  hour: string
  minute: string
}

function usageDateParts(date: Date): UsageDateParts | null {
  try {
    const dateParts = new Intl.DateTimeFormat('pt-BR', {
      timeZone: SAO_PAULO_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date)
    const timeParts = new Intl.DateTimeFormat('pt-BR', {
      timeZone: SAO_PAULO_TIME_ZONE,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(date)
    const value = (parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((part) => part.type === type)?.value ?? ''
    const year = Number(value(dateParts, 'year'))
    const month = Number(value(dateParts, 'month'))
    const day = Number(value(dateParts, 'day'))
    const hour = value(timeParts, 'hour')
    const minute = value(timeParts, 'minute')
    if (
      !Number.isInteger(year) ||
      !Number.isInteger(month) ||
      !Number.isInteger(day) ||
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > 31 ||
      !/^\d{2}$/u.test(hour) ||
      !/^\d{2}$/u.test(minute)
    )
      return null
    return { year, month, day, hour, minute }
  } catch {
    // A formatting failure must not erase the original CLI message.
    return null
  }
}

function calendarDayKey(parts: UsageDateParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day)
}

function usageResetDate(rawEpoch: string): Date | null {
  const epoch = Number(rawEpoch)
  if (!Number.isSafeInteger(epoch) || epoch < 0) return null
  // Claude's marker is normally Unix seconds. Accept milliseconds as well so
  // a future CLI change does not turn a valid reset into a misleading date.
  const milliseconds = epoch < 1_000_000_000_000 ? epoch * 1_000 : epoch
  const date = new Date(milliseconds)
  return Number.isFinite(date.getTime()) ? date : null
}

function formatUsageLimitLine(rawLine: string, now: Date): string | null {
  const match = USAGE_LIMIT_LINE.exec(rawLine)
  if (!match) return null
  const resetAt = usageResetDate(match[1])
  if (!resetAt) return null
  const reset = usageDateParts(resetAt)
  const current = usageDateParts(now)
  if (!reset || !current) return null

  const label =
    calendarDayKey(reset) === calendarDayKey(current)
      ? 'hoje'
      : calendarDayKey(reset) === calendarDayKey(current) + 86_400_000
        ? 'amanhã'
        : `${String(reset.day).padStart(2, '0')}/${String(reset.month).padStart(2, '0')}/${reset.year}`
  const datePrefix = label === 'hoje' || label === 'amanhã' ? `de ${label}` : `em ${label}`
  return `seu limite volta às ${reset.hour}:${reset.minute} ${datePrefix} (horário de São Paulo)`
}

/**
 * Converte a linha de limite emitida pelo Claude para uma mensagem curta em
 * PT-BR. `now` é injetável para manter o helper puro e testável; payloads
 * desconhecidos continuam intactos para nunca esconder a informação original.
 */
export function formatUsageLimitText(text: string, now = Date.now()): string {
  if (typeof text !== 'string' || text.length === 0) return text
  const current = new Date(now)
  if (!Number.isFinite(current.getTime())) return text
  let changed = false
  const formatted = text.split(/\r?\n/u).map((line) => {
    const next = formatUsageLimitLine(line, current)
    if (next === null) return line
    changed = true
    return next
  })
  return changed ? formatted.join('\n') : text
}
