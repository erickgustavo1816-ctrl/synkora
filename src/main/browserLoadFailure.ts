/** Describe a refused loopback preview without repeating a raw Chromium error. */
export function browserLoadFailureText(url: string, detail: string): string {
  try {
    const target = new URL(url)
    if (['http:', 'https:'].includes(target.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) &&
      detail.includes('ERR_CONNECTION_REFUSED')) {
      const port = target.port || (target.protocol === 'https:' ? '443' : '80')
      return `a prévia local na porta ${port} recusou a conexão — aguarde o servidor iniciar ou reinicie a prévia; depois use ⟳`
    }
  } catch { /* Keep the normal bounded error for a URL that cannot be parsed. */ }
  return `não carregou ${url.slice(0, 160)} — ${detail.slice(0, 200)}`
}
