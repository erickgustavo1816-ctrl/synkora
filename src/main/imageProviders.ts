import { spawn } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join, isAbsolute } from 'path'
import { CodexSession } from './codexSession'
import { freshWindowsPath } from './winPath'
import type { SynkoraSettings } from './settings'

// Provedores de geração de imagem — plugáveis atrás da tool MCP generate_image.
// Hoje: codex (ferramenta image_generation nativa do modelo, sondada de
// verdade via `codex features list`). Futuro: OpenRouter (gpt-image / nano
// banana). Princípio do projeto: NADA mocado — available() é sondagem real.

export interface ImageRequest {
  prompt: string
  outDir: string
  fileName?: string
}

export interface ImageResult {
  ok: boolean
  files: string[]
  detail: string
}

export interface ImageProvider {
  name: string
  available(): Promise<{ ok: boolean; reason?: string }>
  generate(req: ImageRequest): Promise<ImageResult>
}

function safeName(name: string | undefined): string {
  const base = (name ?? `img-${Date.now()}`).replace(/[^\w.-]/g, '-').replace(/\.png$/i, '')
  return `${base}.png`
}

// cache da sondagem por configDir (10 min) — `features list` é rápido mas
// não precisa rodar a cada chamada.
const codexFeatureCache = new Map<string, { ok: boolean; reason?: string; at: number }>()

export class CodexImageProvider implements ImageProvider {
  name = 'codex'

  constructor(private configDir?: string) {}

  available(): Promise<{ ok: boolean; reason?: string }> {
    const key = this.configDir ?? '~'
    const hit = codexFeatureCache.get(key)
    if (hit && Date.now() - hit.at < 600_000) return Promise.resolve(hit)
    return new Promise((resolve) => {
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        PATH: freshWindowsPath()
      }
      if (this.configDir) env['CODEX_HOME'] = this.configDir
      const child = spawn('codex', ['features', 'list'], {
        env,
        shell: process.platform === 'win32'
      })
      let out = ''
      child.stdout.on('data', (d: Buffer) => (out += d.toString()))
      const done = (res: { ok: boolean; reason?: string }): void => {
        codexFeatureCache.set(key, { ...res, at: Date.now() })
        resolve(res)
      }
      child.on('error', () => done({ ok: false, reason: 'codex não encontrado no PATH' }))
      child.on('close', () => {
        const line = out.split('\n').find((l) => l.includes('image_generation'))
        if (line && /\btrue\b/.test(line)) done({ ok: true })
        else
          done({
            ok: false,
            reason: 'o codex instalado não reporta a feature image_generation habilitada'
          })
      })
      setTimeout(() => done({ ok: false, reason: 'codex features list não respondeu' }), 20_000)
    })
  }

  generate(req: ImageRequest): Promise<ImageResult> {
    mkdirSync(req.outDir, { recursive: true })
    const outPath = join(req.outDir, safeName(req.fileName))
    return new Promise((resolve) => {
      let lastText = ''
      let settled = false
      const finish = (res: ImageResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        session.kill()
        resolve(res)
      }
      const session: CodexSession = new CodexSession(
        {
          cwd: req.outDir,
          configDir: this.configDir,
          sandbox: 'workspace-write',
          approvalPolicy: 'never'
        },
        'Você gera imagens sob demanda usando a sua ferramenta de geração de imagens. Sem conversa: gere, salve no caminho pedido e responda só com o caminho final.',
        (evt) => {
          switch (evt.type) {
            case 'text':
              lastText = evt.text
              break
            case 'permission':
              session.answerPermission(evt.requestId, 'allow')
              break
            case 'result': {
              if (evt.isError) {
                finish({ ok: false, files: [], detail: evt.errorText ?? 'turno falhou' })
                break
              }
              if (existsSync(outPath)) {
                finish({ ok: true, files: [outPath], detail: 'gerada pelo codex' })
                break
              }
              // o modelo pode ter salvo noutro caminho e respondido com ele
              const said = lastText.trim().split(/\s+/).find((w) => /\.(png|jpe?g|webp)$/i.test(w))
              const alt = said && (isAbsolute(said) ? said : join(req.outDir, said))
              if (alt && existsSync(alt)) {
                finish({ ok: true, files: [alt], detail: 'gerada pelo codex' })
              } else {
                finish({
                  ok: false,
                  files: [],
                  detail: `o codex terminou mas o arquivo não apareceu (resposta: ${lastText.slice(0, 160) || 'vazia'})`
                })
              }
              break
            }
            case 'fatal':
              finish({ ok: false, files: [], detail: evt.text })
              break
            default:
              break
          }
        }
      )
      const timer = setTimeout(
        () => finish({ ok: false, files: [], detail: 'timeout (4 min) gerando a imagem' }),
        240_000
      )
      session.send(
        `Gere UMA imagem com a sua ferramenta de geração de imagens.\n` +
          `Descrição da imagem: ${req.prompt}\n` +
          `Salve o resultado EXATAMENTE em: ${outPath}\n` +
          `Se a ferramenta salvar em outro lugar (ex.: generated_images), COPIE o arquivo para esse caminho com o shell.\n` +
          `Quando o arquivo existir nesse caminho, responda APENAS com o caminho.`
      )
    })
  }
}

export class OpenRouterImageProvider implements ImageProvider {
  name = 'openrouter'

  constructor(private settings: SynkoraSettings) {}

  available(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.settings.openrouterKey)
      return Promise.resolve({
        ok: false,
        reason: 'defina a API key do OpenRouter em Configurações › Imagens'
      })
    return Promise.resolve({ ok: true })
  }

  async generate(req: ImageRequest): Promise<ImageResult> {
    mkdirSync(req.outDir, { recursive: true })
    const outPath = join(req.outDir, safeName(req.fileName))
    const model = this.settings.openrouterModel || 'google/gemini-2.5-flash-image'
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.settings.openrouterKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: req.prompt }],
          modalities: ['image', 'text']
        })
      })
      if (!res.ok) {
        return { ok: false, files: [], detail: `OpenRouter HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` }
      }
      const data = (await res.json()) as {
        choices?: { message?: { images?: { image_url?: { url?: string } }[] } }[]
      }
      const url = data.choices?.[0]?.message?.images?.[0]?.image_url?.url
      const b64 = url?.startsWith('data:') ? url.split(',')[1] : undefined
      if (!b64) return { ok: false, files: [], detail: `resposta do ${model} sem imagem` }
      writeFileSync(outPath, Buffer.from(b64, 'base64'))
      return { ok: true, files: [outPath], detail: `gerada via OpenRouter (${model})` }
    } catch (err) {
      return {
        ok: false,
        files: [],
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  }
}
