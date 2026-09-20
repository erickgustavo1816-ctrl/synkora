import { useMobilePhone } from '../useMobilePhone'
import MobileViewport from './MobileViewport'
import GuiPanelErrorBoundary from './GuiPanelErrorBoundary'
import './DockMobile.css'
import './MobilePhone.css'

export default function MobilePhone({ windowId }: { windowId: string }): React.JSX.Element {
  const phone = useMobilePhone(windowId)
  const descriptor = phone.descriptor, session = descriptor?.session ?? null
  return <main className="mobile-phone-window" data-testid="mobile-phone-window" data-platform={descriptor?.platform} data-window-clamped={phone.clamped || undefined}>
    {phone.error && <div className="mobile-phone-window-notice" role="status">{phone.error}</div>}
    {!descriptor && !phone.error && <div className="mobile-phone-window-notice" role="status">Abrindo aparelho…</div>}
    {descriptor && <GuiPanelErrorBoundary paneId={`mobile-phone:${windowId}`} label="o aparelho destacado">
      <MobileViewport missionId={descriptor.missionId} session={session} profileId={session?.displayProfileId}
        visible={phone.enabled} busy={phone.docking || !!session?.presentation?.transitioning} act={phone.act}
        expanded={false} onToggleExpanded={() => {}} presentation="detached" initialScaleMode="physical"
        client={phone.client} onContentSize={phone.contentSize} onCloseWindow={() => { void phone.dock() }} closingWindow={phone.docking} />
    </GuiPanelErrorBoundary>}
    {phone.clamped && <span className="mobile-sr-only" role="status">A janela foi ajustada à área disponível. Use o zoom para ajustar o aparelho.</span>}
  </main>
}
