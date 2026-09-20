/** Shared schemas keep bulk and single operations within the same limits. */
import { z } from 'zod'
import { BROWSER_ACT_MAX_STEPS, BROWSER_READ_CEILING_CHARS, BROWSER_WAIT_MAX_MS } from './browserDriver'
import { BROWSER_VIEWPORT_MIN_WIDTH, BROWSER_VIEWPORT_MAX_WIDTH } from './browserViewport'
import { BROWSER_SHOT_MAX_WIDTH } from './browserShot'
import {
  BROWSER_CHECK_MAX_SCENARIOS, BROWSER_CHECK_MAX_TARGETS,
  BROWSER_CHECK_MAX_MS, BROWSER_CHECK_MAX_CHARS
} from './browserCheck'

export const browserReadSchema = {
  filter: z.enum(['interactive', 'all']).optional().describe('all: texto e controles; interactive: só controles'),
  scope: z.string().min(1).max(300).optional().describe('seletor CSS do trecho pertinente'),
  detail: z.enum(['compact', 'full']).optional().describe('compact por padrão; full recupera a leitura detalhada'),
  responseMaxChars: z.number().int().min(500).max(BROWSER_READ_CEILING_CHARS).optional().describe('orçamento da resposta inteira; compacto padrão 2000'),
  baselineId: z.string().max(160).optional().describe('id de observação anterior desta aba/escopo; devolve mudanças ou leitura nova se incompatível'),
  depth: z.number().int().min(1).max(40).optional(),
  maxChars: z.number().int().min(500).max(BROWSER_READ_CEILING_CHARS).optional().describe('teto do corpo da leitura; responseMaxChars limita o total')
}

export const browserActionSchema = z.object({
  action: z.enum(['click', 'double_click', 'right_click', 'hover', 'type', 'press', 'scroll', 'select', 'fill', 'clear']),
  ref: z.number().int().min(1).optional(),
  selector: z.string().min(1).max(300).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  text: z.string().max(4000).optional(),
  key: z.string().max(40).optional(),
  value: z.string().max(4000).optional(),
  direction: z.enum(['up', 'down', 'left', 'right']).optional(),
  amount: z.number().int().optional(),
  clear: z.boolean().optional()
})

export const browserWaitSchema = z.object({
  selector: z.string().min(1).max(300).optional(),
  text: z.string().min(1).max(300).optional(),
  networkIdle: z.boolean().optional(),
  ms: z.number().int().min(0).max(BROWSER_WAIT_MAX_MS).optional(),
  timeoutMs: z.number().int().min(200).max(BROWSER_WAIT_MAX_MS).optional()
})

export const browserCheckSchema = {
  url: z.string().max(2000).optional(),
  scenarios: z.array(z.object({
    width: z.number().int().min(BROWSER_VIEWPORT_MIN_WIDTH).max(BROWSER_VIEWPORT_MAX_WIDTH).optional(),
    actions: z.array(browserActionSchema).min(1).max(BROWSER_ACT_MAX_STEPS).optional().describe('só neste cenário; máximo 24 ações no roteiro inteiro'),
    wait: browserWaitSchema.optional().describe('condição após as ações e antes das medições')
  })).min(1).max(BROWSER_CHECK_MAX_SCENARIOS).optional(),
  targets: z.array(z.object({
    selector: z.string().min(1).max(300),
    checks: z.array(z.enum(['visible', 'inViewport', 'noHorizontalOverflow', 'unoccluded'])).min(1).max(4).optional().describe('padrão visible; noHorizontalOverflow mede conteúdo/caixa do alvo')
  })).min(1).max(BROWSER_CHECK_MAX_TARGETS),
  capture: z.object({
    name: z.string().max(60).optional(),
    selector: z.string().min(1).max(300).optional(),
    purpose: z.enum(['artifact', 'vision']).optional(),
    maxWidth: z.number().int().min(200).max(BROWSER_SHOT_MAX_WIDTH).optional()
  }).optional().describe('uma captura por cenário; artifact padrão, vision quando o modelo precisa ver a aparência'),
  timeoutMs: z.number().int().min(200).max(BROWSER_CHECK_MAX_MS).optional().describe('orçamento entre passos; aguarda a operação em curso terminar antes de retornar'),
  responseMaxChars: z.number().int().min(500).max(BROWSER_CHECK_MAX_CHARS).optional().describe('teto textual total; padrão 2000, corte declarado')
}
