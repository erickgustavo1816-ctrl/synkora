/** Numeric-only usage snapshots shared by main and renderer. Null means the
 * provider did not supply a complete measurement; it must never become zero. */
export interface GuiUsageParcels {
  inputTokens: number | null
  cacheWriteTokens: number | null
  cacheReadTokens: number | null
  outputTokens: number | null
}

export interface GuiUsageTotals extends GuiUsageParcels {
  /** Available only when distinct requests can be counted. Never MCP calls. */
  apiCalls: number | null
}

export interface GuiUsageRound {
  /** Opaque local work boundary, not a provider request ID or prompt text. */
  id: string
  usage: GuiUsageTotals | null
  partial?: true
}

export interface GuiUsageMeters {
  conversation: GuiUsageTotals | null
  /** Some work could not be attributed. Numbers are measured subtotals. */
  partial?: true
  /** Latest owner work round; steering received during work belongs to it. */
  round: GuiUsageRound | null
}
