import { browserReferenceSnapshotInPage } from './browserReferenceSnapshot'
import { BROWSER_REFERENCE_ICON_SVG } from './browserReferenceIcon'

/** A native toolbar action. Selection is read at confirmation, never on hover,
 * inspectNodeRequested or navigation through the Elements tree. */
export function browserReferenceDevtoolsScript(binding: string, key: string): string {
  const iconMask = `url("data:image/svg+xml,${encodeURIComponent(BROWSER_REFERENCE_ICON_SVG)}")`
  return `(async () => {
    const SDK = await import('./core/sdk/sdk.js');
    const UI = await import('./ui/legacy/legacy.js');
    const context = UI.Context?.Context?.instance();
    const toolbar = UI.InspectorView?.InspectorView?.instance().tabbedPane?.leftToolbar();
    if (!context?.flavor || !context.addFlavorChangeListener || !context.removeFlavorChangeListener ||
        !SDK.DOMModel?.DOMNode || !UI.Toolbar?.ToolbarButton || !toolbar?.appendToolbarItem || !toolbar.removeToolbarItem)
      throw new Error('unsupported native inspector toolbar');
    globalThis[${JSON.stringify(key)}]?.dispose();
    const button = new UI.Toolbar.ToolbarButton(
      'Referenciar no chat', 'select-element', undefined, 'synkora-reference');
    button.element.dataset.synkoraReference = 'button';
    // Override only this control's native mask. Icon sizing, colors, focus,
    // disabled appearance and keyboard behavior stay native to DevTools.
    button.element.style.setProperty('--image-file-select-element', ${JSON.stringify(iconMask)});
    const owner = {};
    let sequence = 0, disposed = false, activeId = null, captureTimer, feedbackTimer;
    const send = payload => {
      if (disposed) return false;
      try { globalThis[${JSON.stringify(binding)}](JSON.stringify(payload)); return true; } catch { return false; }
    };
    const snapshot = ${browserReferenceSnapshotInPage.toString()};
    const selected = () => {
      const node = context.flavor(SDK.DOMModel.DOMNode)?.enclosingElementOrSelf();
      return node?.nodeType() === 1 ? node : null;
    };
    const update = () => {
      if (disposed) return;
      const node = selected();
      button.setEnabled(!activeId && Boolean(node));
      if (activeId) return;
      button.setGlyph('select-element');
      button.element.removeAttribute('aria-busy');
      button.setTitle(node ? 'Referenciar no chat — ' + node.simpleSelector().slice(0,180) :
        'Referenciar no chat — selecione um elemento na página ou na árvore das DevTools');
      delete button.element.dataset.referenceResult;
    };
    const complete = (id, ok, message) => {
      if (disposed || activeId !== id) return;
      activeId = null;
      clearTimeout(captureTimer);
      clearTimeout(feedbackTimer);
      update();
      button.element.dataset.referenceResult = ok ? 'success' : 'error';
      button.setGlyph(ok ? 'checkmark' : 'warning');
      button.setTitle(ok ? 'Referenciar no chat — referência adicionada ao rascunho' :
        message || 'Não consegui guardar esse elemento. Clique novamente para tentar.');
      if (ok) feedbackTimer = setTimeout(update, 1500);
    };
    const capture = () => {
      if (disposed || activeId) return;
      // Hold the node chosen by the owner even if the tree selection changes
      // while its remote object and geometry are being resolved.
      const node = selected();
      if (!node) { update(); return; }
      const id = String(++sequence), backendNodeId = node.backendNodeId();
      activeId = id;
      clearTimeout(feedbackTimer);
      button.setEnabled(false);
      button.setGlyph('select-element');
      button.setTitle('Referenciando o elemento selecionado no chat…');
      button.element.setAttribute('aria-busy', 'true');
      delete button.element.dataset.referenceResult;
      captureTimer = setTimeout(() => complete(id, false,
        'Não recebi a confirmação. Feche e abra as DevTools e tente novamente.'), 6500);
      if (!send({type:'start', id, backendNodeId})) {
        complete(id, false, 'Não consegui conectar ao chat. Feche e abra as DevTools.');
        return;
      }
      void (async () => {
        let object;
        try {
          object = await node.resolveToObject('synkora-reference');
          if (!object) throw new Error('element no longer exists');
          const value = await object.callFunctionJSON(snapshot);
          if (!value) throw new Error('element no longer exists');
          if (!send({type:'snapshot', id, backendNodeId, frameId:node.frameId(), value}))
            complete(id, false, 'Não consegui conectar ao chat. Feche e abra as DevTools.');
        } catch {
          if (!send({type:'error', id})) complete(id, false);
        } finally { object?.release(); }
      })();
    };
    button.addEventListener('Click', capture, owner);
    context.addFlavorChangeListener(SDK.DOMModel.DOMNode, update, owner);
    // Same native toolbar as Select Element; DevTools handles its layout,
    // keyboard navigation and light/dark theme, including narrow windows.
    toolbar.appendToolbarItem(button);
    update();
    globalThis[${JSON.stringify(key)}] = {complete, dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(captureTimer);
      clearTimeout(feedbackTimer);
      button.removeEventListener('Click', capture, owner);
      context.removeFlavorChangeListener(SDK.DOMModel.DOMNode, update, owner);
      toolbar.removeToolbarItem(button);
      delete globalThis[${JSON.stringify(key)}];
    }};
    return true;
  })()`
}
