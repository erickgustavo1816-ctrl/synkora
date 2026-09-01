import type { SynkoraApi, SynkoraOverlayApi, SynkoraProgressOverlayApi } from './index'

/** SKILLS 2.0 — o contrato que a tela de Ajustes ▸ Skills consome. Espelho
 *  declarado de `src/main/skillsKit.ts` (kit) e `src/main/ipc/skills.ts`
 *  (biblioteca/instalação/poda); a definição mora em `./index`, aqui só o
 *  reexport para quem importa pelo arquivo de tipos. */
/** BROWSER EMBUTIDO — espelho declarado de `src/main/ipc/browser.ts`; a
 *  definição mora em `./index`, aqui só o reexport para quem importa pelo
 *  arquivo de tipos (o painel `components/DockBrowser.tsx` e o modelo puro
 *  `dockBrowserModel.ts`). */
export type {
  BrowserActionResult,
  BrowserHostKind,
  BrowserNoticeView,
  BrowserPanelState,
  BrowserRect,
  BrowserTab,
  BrowserTabOwner,
  BrowserTabOwnerKind,
  BrowserViewportMode
} from './index'

export type {
  SkillChatType,
  SkillDevWing,
  SkillInstallResult,
  SkillsKitSlot,
  SkillsKitState,
  SkillsLibraryItem,
  SkillsListResult,
  SkillsPruneResult
} from './index'

declare global {
  interface Window {
    synkora: SynkoraApi
    synkoraOverlay: SynkoraOverlayApi
    synkoraProgressOverlay: SynkoraProgressOverlayApi
  }
}

export {}
