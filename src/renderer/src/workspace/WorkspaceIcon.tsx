import type { WorkspacePanelId } from '../workspacePanels'

export default function WorkspaceIcon({ name }: {
  name: WorkspacePanelId | 'menu' | 'sidebar' | 'expand' | 'restore' | 'close' | 'upload' | 'terminal' | 'review' | 'archive' | 'check' | 'discard'
    | 'play' | 'plus' | 'branch' | 'chevron' | 'arrow' | 'ask' | 'queue' | 'plan'
}): React.JSX.Element {
  const paths: Record<typeof name, React.ReactNode> = {
    browser: <><circle cx="10" cy="10" r="7" /><ellipse cx="10" cy="10" rx="3" ry="7" /><path d="M3 10h14" /></>,
    mobile: <><rect x="5" y="1.5" width="10" height="17" rx="2" /><path d="M8.5 4h3m-2 12h1" /></>,
    frota: <><rect x="7.5" y="2" width="5" height="4" rx="1" /><rect x="2" y="13" width="5" height="4" rx="1" /><rect x="13" y="13" width="5" height="4" rx="1" /><path d="M10 6v4M4.5 13v-3h11v3" /></>,
    trabalho: <><path d="M3 6h6M6 3v6M12 14h5M4 17l12-14" /></>,
    upload: <path d="M10 13V3m-4 4 4-4 4 4M3 12v5h14v-5" />,
    terminal: <><rect x="2.5" y="3.5" width="15" height="13" rx="2" /><path d="m6 7 3 3-3 3m5 0h3" /></>,
    review: <><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4m-11-8 2 2 3-3" /></>,
    archive: <><rect x="2.5" y="3" width="15" height="4" rx="1" /><path d="M4 7v10h12V7m-8 4h4" /></>,
    check: <path d="m4 10 4 4 8-8" />,
    historico: <><path d="M3 7a7 7 0 1 1 0 6M3 3v4h4M10 6v4l3 2" /></>,
    release: <path d="M10 17V7m-4 4 4-4 4 4M4 3h12" />,
    discard: <><path d="M4 6h12M8 6V4h4v2M6 6l.8 11h6.4L14 6" /><path d="M8.5 9.5v5m3-5v5" /></>,
    menu: <><circle cx="10" cy="4" r=".7" fill="currentColor" /><circle cx="10" cy="10" r=".7" fill="currentColor" /><circle cx="10" cy="16" r=".7" fill="currentColor" /></>,
    sidebar: <><rect x="2.5" y="3" width="15" height="14" rx="2" /><path d="M7.5 3v14" /></>,
    expand: <path d="M12 3h5v5M17 3l-5 5M8 17H3v-5M3 17l5-5" />,
    restore: <path d="M17 8h-5V3M12 8l5-5M3 12h5v5M8 12l-5 5" />,
    close: <path d="m5 5 10 10M5 15l10-10" />,
    play: <path d="M6.5 4.5v11l9-5.5z" />,
    plus: <path d="M10 4v12M4 10h12" />,
    branch: <><circle cx="5.5" cy="15" r="2" /><circle cx="14.5" cy="5.5" r="2" /><path d="M5.5 3v10m9-5.5a7 7 0 0 1-7 7" /></>,
    chevron: <path d="m5.5 8 4.5 4.5L14.5 8" />,
    arrow: <path d="M4 10h12m-4.5-4.5L16 10l-4.5 4.5" />,
    ask: <><circle cx="10" cy="10" r="7" /><path d="M7.9 7.9a2.2 2.2 0 1 1 3 2c-.6.3-.9.7-.9 1.3v.4M10 14.2v.1" /></>,
    queue: <><circle cx="10" cy="10" r="7" /><path d="M10 6v4l2.6 1.6" /></>,
    plan: <><path d="M5 3.5h7l3 3v10H5z" /><path d="M8 10h5M8 13h3" /></>
  }
  return <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}
