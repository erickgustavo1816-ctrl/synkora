/**
 * MCP API — domínio images (fase 1, commit 4b).
 * Geração de imagens via provedor configurado (Codex/OpenRouter).
 *
 * Corpo movido VERBATIM do literal mcpApi do index.ts. O return é tipado
 * Pick<McpApi, …> para preservar o contextual typing que o literal dava aos
 * parâmetros. uiSender/mcpPort (e campos nascidos depois do literal, como
 * mcpPaneFirstContact) são lidos via ctx a cada uso — getters reativos.
 */
import { join } from 'path'
import { redactSensitiveText } from '../securityRedaction'
import { CodexImageProvider, OpenRouterImageProvider, type ImageProvider } from '../imageProviders'
import type { MainContext } from '../mainContext'
import type { McpApi } from '../mcpServer'

export function buildImagesApi(
  ctx: MainContext
): Pick<McpApi, 'generateImage'> {
  const {
    seats,
    settings
  } = ctx
  // hub é atribuído 1× antes do mcpApi nascer — capturar é seguro.
  const hub = ctx.hub
  return {
    generateImage: async (id, prompt, fileName) => {
      const sanitizedPrompt = redactSensitiveText(prompt)
      if (sanitizedPrompt !== prompt) {
        return 'geração recusada: o prompt parece conter credencial ou dado de autenticação. Remova o valor sensível e descreva apenas o resultado visual desejado.'
      }
      const s = settings.get()
      let provider: ImageProvider
      if (s.imageProvider === 'openrouter') {
        provider = new OpenRouterImageProvider(s)
      } else {
        const seat =
          (s.imageSeatId ? seats.get(s.imageSeatId) : undefined) ??
          seats.list().find((x) => x.cli === 'codex')
        if (!seat)
          return 'nenhuma conta Codex disponível para gerar imagens — adicione em Configurações › Minhas contas ou troque o provedor em Configurações › Imagens'
        seats.preseed(seat)
        provider = new CodexImageProvider(seats.configDirOf(seat))
      }
      const avail = await provider.available()
      if (!avail.ok) return `provedor de imagens (${provider.name}) indisponível: ${avail.reason}`
      hub.publish({
        projectId: id.projectId,
        kind: 'image',
        text: `gerando imagem via ${provider.name}: ${prompt.slice(0, 80)}`,
        actor: id.role
      })
      const res = await provider.generate({
        prompt,
        outDir: join(id.cwd, '.synkora', 'attachments'),
        fileName
      })
      hub.publish({
        projectId: id.projectId,
        kind: res.ok ? 'image' : 'error',
        text: res.ok
          ? `imagem pronta: ${res.files.join(', ')}`
          : `geração de imagem falhou: ${redactSensitiveText(res.detail)}`,
        actor: provider.name
      })
      return res.ok
        ? `imagem gerada em: ${res.files.join(', ')} (${redactSensitiveText(res.detail)}) — use esse arquivo no seu trabalho`
        : `geração falhou: ${redactSensitiveText(res.detail)}`
    }
  }
}
