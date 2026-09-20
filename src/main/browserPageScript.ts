/**
 * O PROGRAMA QUE RODA DENTRO DA PÁGINA (fatia H2 do design
 * `.synkora/reports/DESIGN_BROWSER_EMBUTIDO_2026-08-29.md`).
 *
 * Este arquivo é um módulo separado porque o que ele guarda É outro programa:
 * uma função JavaScript que viaja como TEXTO até o `Runtime.evaluate` da aba e
 * roda no contexto da página, não no do app. Misturá-lo com o motor de CDP
 * confundiria duas linguagens de execução no mesmo arquivo.
 *
 * ═══ POR QUE A ÁRVORE SAI DAQUI, E NÃO DO `Accessibility.getFullAXTree` ═══
 *
 * Números da sonda (P4, página de 4 821 nós):
 *   · `Accessibility.getFullAXTree` — 79 ms e **1 672 927 bytes**
 *   · `DOMSnapshot.captureSnapshot` — 16 ms e **305 035 bytes**
 *   · `Runtime.evaluate` (innerText) — **0,4 ms** e 35 005 bytes
 *
 * O veredito da sonda, verbatim: "o AX tree cru é impagável como resposta de
 * tool: 1,67 MB. O tempo (79 ms) nunca foi o problema — o payload é." E o
 * payload é problema DUAS vezes: ele atravessa a ponte do debugger para o
 * MAIN, que é a thread que desenha a tela do dono; e filtrar no main não
 * evita nada, porque o megabyte já atravessou. Filtrando aqui DENTRO, o que
 * cruza a ponte já é o texto final. O `DOMSnapshot` perde nos dois eixos: 305
 * KB inteiros e sem papel (role) nenhum, que teríamos de re-derivar do mesmo
 * jeito.
 *
 * E há o ganho que só este caminho dá: o passo que NUMERA os refs já PRENDE o
 * elemento num registro aqui dentro, então a ação seguinte resolve
 * `ref → elemento → caixa` numa ida só. Pelo AX tree, cada ação pagaria
 * `DOM.resolveNode` + `DOM.getBoxModel` a mais.
 *
 * O preço, dito em voz alta: papel e nome acessível saem de uma heurística
 * nossa (tag + ARIA + label), não do motor de acessibilidade do Chromium. Para
 * QA de UI própria é suficiente, e é o mesmo desenho do `agent-browser` da
 * Vercel (Apache-2.0), que a pesquisa registrou como o formato mais enxuto do
 * mercado.
 *
 * ═══ REGRAS DE ESCRITA DESTE ARQUIVO ═══
 *
 * O script é um template literal: dentro dele **não pode existir crase nem
 * `${`** (viraria interpolação do TypeScript), e todo `\` de regex precisa ser
 * escrito duplicado. Ele também não pode lançar: qualquer falha volta como
 * `{ ok: false, error }`, porque uma exceção aqui vira um erro de protocolo
 * que o agente racionalizaria como "a página não existe".
 */

// —————————————————————— o que a página devolve ao main ——————————————————————

export interface PageReadResult {
  ok: true
  text: string
  lines: number
  refs: number
  hidden: number
  truncated: boolean
  url: string
  title: string
  epoch: number
  /** Bounded structural evidence, never a comparison of painted pixels. */
  layout?: {
    signature: string
    complete: boolean
    stable: boolean
    viewport: { w: number; h: number }
    readyState: string
  }
}

export interface PageResolveResult {
  ok: true
  x: number
  y: number
  box: { x: number; y: number; w: number; h: number }
  tag: string
  role: string
  name: string
  visible: boolean
  occluded: boolean
  occluder: string
  disabled: boolean
  applied?: string
}

export interface PageWaitResult {
  ok: true
  hit: boolean
}

export interface PageFailure {
  ok: false
  error: string
  /** ref morto ou de outra leitura: o driver anexa a receita do epoch. */
  stale?: boolean
  /** o `scope` pedido não existe: a receita é outra (ler sem escopo). */
  scopeMiss?: boolean
}

export type PageResult<T> = T | PageFailure

export function isPageFailure(value: unknown): value is PageFailure {
  return !!value && typeof value === 'object' && (value as { ok?: unknown }).ok === false
}

/** As ações que o DOM resolve melhor que o `Input.dispatch*`. */
export type PageActKind = 'select' | 'fill' | 'clear' | 'focus'

export const PAGE_SCRIPT = `function (p) {
  try {
    var KEY = '__SYNKORA_BROWSER__'
    var store = window[KEY]
    if (!store || store.epoch !== p.epoch) {
      store = { epoch: p.epoch, next: 1, byRef: new Map(), refOf: new WeakMap() }
      window[KEY] = store
    }
    if (store.byRef.size > 4000) {
      var dead = []
      store.byRef.forEach(function (el, n) { if (!el.isConnected) dead.push(n) })
      for (var d = 0; d < dead.length; d++) store.byRef.delete(dead[d])
    }
    function refOf(el) {
      var n = store.refOf.get(el)
      if (n === undefined) { n = store.next++; store.refOf.set(el, n) }
      store.byRef.set(n, el)
      return n
    }
    function elOfRef(n) {
      var el = store.byRef.get(n)
      if (!el || !el.isConnected) return null
      return el
    }
    function clean(s, cap) {
      s = String(s == null ? '' : s).replace(/\\s+/g, ' ').trim()
      return s.length > cap ? s.slice(0, cap) + '\\u2026' : s
    }
    function tagOf(el) { return String(el.tagName || '').toUpperCase() }
    function roleOf(el) {
      var explicit = el.getAttribute && el.getAttribute('role')
      if (explicit) return explicit.split(/\\s+/)[0]
      var t = tagOf(el)
      if (t === 'A') return el.hasAttribute('href') ? 'link' : 'generic'
      if (t === 'BUTTON' || t === 'SUMMARY') return 'button'
      if (t === 'INPUT') {
        var ty = String(el.getAttribute('type') || 'text').toLowerCase()
        if (ty === 'hidden') return ''
        if (ty === 'checkbox') return 'checkbox'
        if (ty === 'radio') return 'radio'
        if (ty === 'button' || ty === 'submit' || ty === 'reset' || ty === 'image') return 'button'
        if (ty === 'range') return 'slider'
        if (ty === 'number') return 'spinbutton'
        if (ty === 'search') return 'searchbox'
        if (ty === 'file') return 'fileinput'
        return 'textbox'
      }
      if (t === 'TEXTAREA') return 'textbox'
      if (t === 'SELECT') return el.multiple ? 'listbox' : 'combobox'
      if (t === 'OPTION') return 'option'
      if (t === 'IMG') return 'image'
      if (t === 'SVG') return 'graphic'
      if (t === 'CANVAS') return 'canvas'
      if (t === 'IFRAME') return 'iframe'
      if (t === 'DIALOG') return 'dialog'
      if (/^H[1-6]$/.test(t)) return 'heading'
      if (t === 'NAV') return 'navigation'
      if (t === 'MAIN') return 'main'
      if (t === 'HEADER') return 'banner'
      if (t === 'FOOTER') return 'contentinfo'
      if (t === 'ASIDE') return 'complementary'
      if (t === 'FORM') return 'form'
      if (t === 'TABLE') return 'table'
      if (t === 'TR') return 'row'
      if (t === 'TD') return 'cell'
      if (t === 'TH') return 'columnheader'
      if (t === 'UL' || t === 'OL') return 'list'
      if (t === 'LI') return 'listitem'
      if (t === 'LABEL') return 'label'
      if (t === 'P') return 'paragraph'
      if (t === 'CODE' || t === 'PRE') return 'code'
      return 'generic'
    }
    var CLICKABLE = { A: 1, BUTTON: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, SUMMARY: 1, OPTION: 1 }
    var INTERACTIVE_ROLE = {
      button: 1, link: 1, checkbox: 1, radio: 1, textbox: 1, searchbox: 1, combobox: 1,
      listbox: 1, option: 1, slider: 1, spinbutton: 1, switch: 1, tab: 1, menuitem: 1,
      menuitemcheckbox: 1, menuitemradio: 1, fileinput: 1
    }
    function interactive(el, role) {
      if (INTERACTIVE_ROLE[role]) return true
      if (CLICKABLE[tagOf(el)]) return true
      var ti = el.getAttribute && el.getAttribute('tabindex')
      if (ti !== null && ti !== undefined && Number(ti) >= 0) return true
      if (el.isContentEditable) return true
      if (el.hasAttribute && el.hasAttribute('onclick')) return true
      return false
    }
    function directText(el, cap) {
      var s = ''
      var kids = el.childNodes || []
      for (var i = 0; i < kids.length; i++) if (kids[i].nodeType === 3) s += kids[i].nodeValue
      s = s.replace(/\\s+/g, ' ').trim()
      if (!s && el.children && el.children.length === 0) s = String(el.textContent || '')
      return clean(s, cap)
    }
    function nameOf(el, role, isInter) {
      var n = el.getAttribute && el.getAttribute('aria-label')
      if (!n && el.getAttribute) {
        var lb = el.getAttribute('aria-labelledby')
        if (lb) {
          var parts = []
          lb.split(/\\s+/).forEach(function (id) {
            var t = document.getElementById(id)
            if (t) parts.push(clean(t.textContent, 60))
          })
          n = parts.join(' ')
        }
      }
      var t = tagOf(el)
      if (!n && t === 'IMG') n = el.getAttribute('alt')
      if (!n && (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT')) {
        if (el.labels && el.labels.length) n = clean(el.labels[0].textContent, 60)
        if (!n) n = el.getAttribute('placeholder') || el.getAttribute('name') || ''
        if (!n && t === 'INPUT') {
          var ty = String(el.getAttribute('type') || '').toLowerCase()
          if (ty === 'button' || ty === 'submit' || ty === 'reset') n = el.value
        }
      }
      if (!n) n = el.getAttribute && el.getAttribute('title')
      if (!n && isInter) n = clean(el.innerText || el.textContent, 80)
      if (!n) n = directText(el, 120)
      return clean(n, role === 'generic' || role === 'paragraph' ? 160 : 80)
    }
    function visible(el) {
      if (el.hidden) return false
      var cs = window.getComputedStyle(el)
      if (!cs) return false
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false
      if (parseFloat(cs.opacity) === 0) return false
      var r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) return false
      return true
    }
    function attrsOf(el, role) {
      var a = []
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') a.push('desabilitado')
      var ty = String(el.getAttribute('type') || '').toLowerCase()
      if (ty === 'checkbox' || ty === 'radio' || role === 'switch') a.push(el.checked ? 'marcado' : 'desmarcado')
      var exp = el.getAttribute('aria-expanded')
      if (exp) a.push(exp === 'true' ? 'aberto' : 'fechado')
      if (el.getAttribute('aria-selected') === 'true' || el.selected) a.push('selecionado')
      if (el.getAttribute('aria-current')) a.push('atual')
      if (el.required) a.push('obrigatorio')
      if (el.getAttribute('aria-invalid') === 'true') a.push('invalido')
      if (role === 'heading') a.push('nivel=' + (el.getAttribute('aria-level') || tagOf(el).slice(1)))
      if (role === 'textbox' || role === 'searchbox' || role === 'spinbutton' || role === 'combobox') {
        if (el.value) a.push('valor="' + clean(el.value, 40) + '"')
        else if (el.getAttribute('placeholder')) a.push('vazio, dica="' + clean(el.getAttribute('placeholder'), 40) + '"')
        else a.push('vazio')
      }
      if (role === 'link') {
        var h = el.getAttribute('href')
        if (h) a.push(clean(h, 70))
      }
      if (document.activeElement === el) a.push('com foco')
      return a
    }
    function boxOf(el) {
      var r = el.getBoundingClientRect()
      return {
        x: Math.round(r.left), y: Math.round(r.top),
        w: Math.round(r.width), h: Math.round(r.height)
      }
    }

    // ————— modo READ / FIND —————
    if (p.mode === 'read' || p.mode === 'find') {
      var root = document.body
      if (p.scope) {
        root = document.querySelector(p.scope)
        if (!root) return { ok: false, error: 'escopo nao encontrado: ' + p.scope, scopeMiss: true }
      }
      if (!root) return { ok: false, error: 'o documento ainda nao tem corpo; aguarde com browser_wait e chame browser_read' }
      var out = []
      var chars = 0
      var truncated = false
      var refs = 0
      var hidden = 0
      var q = p.query ? String(p.query).toLowerCase() : ''
      var layoutA = 2166136261
      var layoutB = 5381
      function layoutHash(value) {
        var str = String(value)
        for (var h = 0; h < str.length; h++) {
          layoutA = Math.imul(layoutA ^ str.charCodeAt(h), 16777619)
          layoutB = Math.imul(layoutB, 33) ^ str.charCodeAt(h)
        }
      }
      function measureLayout(el) {
        if (p.mode !== 'read') return
        var b = el.getBoundingClientRect()
        var cs = window.getComputedStyle(el)
        var styles = ['display', 'visibility', 'opacity', 'position', 'transform', 'color',
          'backgroundColor', 'backgroundImage', 'fontFamily', 'fontSize', 'fontWeight',
          'lineHeight', 'letterSpacing', 'padding', 'margin', 'border', 'overflow', 'zIndex']
        layoutHash([tagOf(el), el.id || '', el.className || '', b.left, b.top, b.width,
          b.height, el.scrollWidth, el.scrollHeight, el.scrollLeft || 0, el.scrollTop || 0,
          (el.children || []).length].join('|'))
        for (var si = 0; si < styles.length; si++) layoutHash(cs[styles[si]] || '')
      }
      layoutHash([window.innerWidth, window.innerHeight, window.scrollX || 0,
        window.scrollY || 0, window.devicePixelRatio || 1, document.readyState,
        document.fonts ? document.fonts.status : 'unknown'].join('|'))
      function emit(el, depth) {
        var role = roleOf(el)
        if (!role) return
        var isInter = interactive(el, role)
        var name = nameOf(el, role, isInter)
        if (p.mode === 'find') {
          if (out.length >= p.limit) { truncated = true; return }
          var hay = (role + ' ' + name).toLowerCase()
          if (q && hay.indexOf(q) < 0) return
          if (p.role && role !== p.role) return
          var b = boxOf(el)
          var mark = isInter ? '[ref_' + refOf(el) + '] ' : ''
          if (isInter) refs++
          out.push(mark + role + (name ? ' "' + name + '"' : '') +
            ' @(' + b.x + ',' + b.y + ') ' + b.w + 'x' + b.h)
          return
        }
        if (p.filter === 'interactive' && !isInter) return
        if (!isInter) {
          if (!name) return
          if (role === 'generic' && !directText(el, 160)) return
        }
        var pad = '  '.repeat(Math.min(depth, 8))
        var mark2 = isInter ? '[ref_' + refOf(el) + '] ' : ''
        var at = attrsOf(el, role)
        var line = pad + mark2 + role + (name ? ' "' + name + '"' : '') +
          (at.length ? ' (' + at.join(', ') + ')' : '')
        if (chars + line.length + 1 > p.maxChars) { truncated = true; return }
        chars += line.length + 1
        if (isInter) refs++
        out.push(line)
      }
      var stack = [{ el: root, depth: 0 }]
      var guard = 0
      while (stack.length && !truncated && guard < 20000) {
        guard++
        var cur = stack.pop()
        measureLayout(cur.el)
        var kids = cur.el.children || []
        for (var k = kids.length - 1; k >= 0; k--) {
          var c = kids[k]
          var tg = tagOf(c)
          if (tg === 'SCRIPT' || tg === 'STYLE' || tg === 'NOSCRIPT' || tg === 'TEMPLATE' ||
              tg === 'HEAD' || tg === 'LINK' || tg === 'META' || tg === 'TITLE') continue
          if (c.getAttribute && c.getAttribute('aria-hidden') === 'true') { hidden++; continue }
          if (!visible(c)) { hidden++; continue }
          if (cur.depth < p.depth && tg !== 'SVG') stack.push({ el: c, depth: cur.depth + 1 })
        }
        if (cur.depth > 0 || (p.scope && visible(cur.el))) emit(cur.el, Math.max(0, cur.depth - 1))
      }
      if (stack.length) truncated = true
      var stable = document.readyState === 'complete' && document.fonts && document.fonts.status === 'loaded'
      if (document.getAnimations) {
        var animations = document.getAnimations()
        for (var ai = 0; ai < animations.length; ai++) {
          if (animations[ai].playState === 'running' || animations[ai].pending) stable = false
        }
      } else stable = false
      // A pilha recebe os filhos em ordem INVERSA (o laço de k desce), entao o
      // primeiro filho e o primeiro a sair: a ordem que sai daqui ja e a do
      // documento. NAO reordenar — reordenar quebraria a leitura.
      return {
        ok: true, text: out.join('\\n'), lines: out.length, refs: refs,
        hidden: hidden, truncated: truncated, url: location.href, title: document.title,
        epoch: store.epoch,
        layout: { signature: String(layoutA >>> 0) + ':' + String(layoutB >>> 0),
          complete: !truncated && guard < 20000, stable: !!stable,
          viewport: { w: window.innerWidth, h: window.innerHeight }, readyState: document.readyState || 'unknown' }
      }
    }

    // ————— modo RESOLVE (ref/seletor -> caixa, oclusao, DOM) —————
    if (p.mode === 'resolve') {
      var el = null
      if (p.selector) el = document.querySelector(p.selector)
      else if (p.ref) el = elOfRef(p.ref)
      if (!el) return { ok: false, stale: !p.selector, error: p.selector ? 'seletor sem correspondencia: ' + p.selector : 'ref ' + p.ref + ' nao existe nesta pagina' }
      if (p.scrollIntoView !== false && el.scrollIntoView) {
        try { el.scrollIntoView({ block: 'center', inline: 'center' }) } catch (e0) { el.scrollIntoView() }
      }
      var bx = boxOf(el)
      var cx = bx.x + Math.floor(bx.w / 2)
      var cy = bx.y + Math.floor(bx.h / 2)
      var top = document.elementFromPoint(cx, cy)
      var occluded = false
      var occluder = ''
      if (top && top !== el && !el.contains(top) && !top.contains(el)) {
        occluded = true
        occluder = tagOf(top).toLowerCase() +
          (top.id ? '#' + top.id : '') +
          (top.className && typeof top.className === 'string' ? '.' + top.className.trim().split(/\\s+/).slice(0, 2).join('.') : '')
      }
      var vis = visible(el)
      var r2 = { ok: true, x: cx, y: cy, box: bx, tag: tagOf(el).toLowerCase(),
        role: roleOf(el), name: nameOf(el, roleOf(el), true), visible: vis,
        occluded: occluded, occluder: occluder, disabled: !!el.disabled }
      if (p.act === 'select') {
        var done = false
        var opts = el.options || []
        for (var oi = 0; oi < opts.length; oi++) {
          if (opts[oi].value === p.value || clean(opts[oi].textContent, 200) === p.value) {
            el.value = opts[oi].value; done = true; break
          }
        }
        if (!done) return { ok: false, error: 'opcao nao encontrada: ' + p.value }
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        r2.applied = 'select'
      }
      if (p.act === 'fill' || p.act === 'clear') {
        var v = p.act === 'clear' ? '' : String(p.value == null ? '' : p.value)
        if (el.isContentEditable) { el.focus(); el.textContent = v }
        else {
          el.focus()
          var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
          var setter = Object.getOwnPropertyDescriptor(proto, 'value')
          if (setter && setter.set) setter.set.call(el, v)
          else el.value = v
        }
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        r2.applied = p.act
      }
      if (p.act === 'focus') { el.focus(); r2.applied = 'focus' }
      return r2
    }

    // ————— modo WAIT (uma sondagem barata; o laco mora no main) —————
    if (p.mode === 'wait') {
      if (p.selector) {
        var w = document.querySelector(p.selector)
        return { ok: true, hit: !!(w && visible(w)) }
      }
      if (p.text) {
        var body = document.body ? (document.body.innerText || document.body.textContent || '') : ''
        return { ok: true, hit: body.toLowerCase().indexOf(String(p.text).toLowerCase()) >= 0 }
      }
      return { ok: true, hit: true }
    }

    return { ok: false, error: 'modo desconhecido: ' + p.mode }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}`

/** A expressão pronta para o `Runtime.evaluate`. O epoch viaja SEMPRE. */
export function buildPageExpression(epoch: number, params: Record<string, unknown>): string {
  return `(${PAGE_SCRIPT})(${JSON.stringify({ epoch, ...params })})`
}

// ————————————————————————————— apresentação —————————————————————————————

/**
 * O rodapé do read: sempre diz o tamanho e o epoch e — quando cortou — a
 * RECEITA para caber. Truncagem silenciosa faria o agente aprovar uma página
 * que ele só leu pela metade.
 */
export function readFooter(
  info: { lines: number; refs: number; hidden: number; truncated: boolean; epoch: number },
  maxChars: number,
  ceiling: number
): string {
  const head = `— ${info.lines} linha(s), ${info.refs} interativo(s)${
    info.hidden ? `, ${info.hidden} oculto(s) omitido(s)` : ''
  } · refs válidos no epoch ${info.epoch} —`
  if (!info.truncated) return head
  return `${head}\n[CORTADO no teto de ${maxChars} caracteres] — a página é maior que o teto. Receita: refaça com filter:"interactive" (só o que se clica), scope:"<seletor CSS>" para uma parte da tela, depth menor, ou maxChars maior (teto ${ceiling}).`
}

/** Como um alvo resolvido aparece no recibo de uma ação. */
export function describeTarget(target: PageResolveResult): string {
  const name = target.name ? ` "${target.name}"` : ''
  return `${target.role}${name} <${target.tag}> @(${target.x}, ${target.y})`
}
