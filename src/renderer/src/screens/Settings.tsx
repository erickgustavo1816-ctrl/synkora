import { useStore, type SettingsSection } from '../store'
import AccessibilitySettings from '../components/AccessibilitySettings'
import ChatNoticeSettings from '../components/ChatNoticeSettings'
import ChatWritingSettings from '../components/ChatWritingSettings'
import NoticeSettings from '../components/NoticeSettings'
import RailGroupSettings from '../components/RailGroupSettings'
import SeatDeck from '../components/SeatDeck'
import SkillsSettings from '../components/SkillsSettings'
import SynVoiceMicrophoneSettings from '../components/SynVoiceMicrophoneSettings'
import SynkoraMark from '../components/SynkoraMark'
import GuiPanelErrorBoundary from '../components/GuiPanelErrorBoundary'

interface NavItem {
  id: SettingsSection
  glyph: string
  label: string
  description: string
}

const NAV: NavItem[] = [
  { id: 'appearance', glyph: 'Aa', label: 'Aparência', description: 'acessibilidade e escrita do chat' },
  { id: 'accounts', glyph: '●', label: 'Minhas contas', description: 'seats e logins' },
  { id: 'skills', glyph: '❖', label: 'Skills', description: 'biblioteca e kits' },
  { id: 'voice', glyph: '◉', label: 'SynVoice', description: 'microfone e voz' }
]

const COPY: Record<SettingsSection, { eyebrow: string; title: string; text: string }> = {
  appearance: {
    eyebrow: 'interface',
    title: 'Aparência',
    text: 'Escala, fonte, movimento e a leitura do chat valem para o Synkora inteiro — nada aqui muda o espaço disponível na tela.'
  },
  accounts: {
    eyebrow: 'identidades de execução',
    title: 'Minhas contas',
    text: 'Cadastre os seats usados pelo Claude Code e Codex e mantenha os logins prontos.'
  },
  skills: {
    eyebrow: 'cardápio dos agentes',
    title: 'Skills',
    text: 'Monte o kit que cada tipo de conversa recebe e cuide da biblioteca desta máquina.'
  },
  voice: {
    eyebrow: 'ditado inteligente',
    title: 'SynVoice',
    text: 'Escolha a entrada de áudio e acesse as opções de transcrição.'
  }
}

export default function Settings(): React.JSX.Element {
  const section = useStore((s) => s.settingsSection)
  const openSettings = useStore((s) => s.openSettings)
  const seats = useStore((s) => s.seats)
  const copy = COPY[section]

  const countFor = (id: SettingsSection): string | null => {
    if (id === 'accounts') return String(seats.length)
    return null
  }

  return (
    <div className="settings-page">
      <div className="settings-paper" aria-hidden="true" />
      <div className="settings-scroll">
        <div className="settings-inner">
          <header className="settings-hero">
            <span className="settings-hero-mark"><SynkoraMark size={24} /></span>
            <div>
              <span className="settings-overline">central global</span>
              <h1>Configurações</h1>
              <p>Preferências do Synkora que acompanham todos os seus universos.</p>
            </div>
          </header>

          <div className="settings-workspace">
            <aside className="settings-nav" aria-label="Seções das configurações">
              <span className="settings-nav-label">configurar</span>
              {NAV.map((item) => {
                const count = countFor(item.id)
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={section === item.id ? 'active' : ''}
                    aria-current={section === item.id ? 'page' : undefined}
                    onClick={() => openSettings(item.id)}
                  >
                    <i>{item.glyph}</i>
                    <span>
                      <strong>{item.label}</strong>
                      <small>{item.description}</small>
                    </span>
                    {count !== null && <b>{count}</b>}
                  </button>
                )
              })}
              <p className="settings-nav-foot">
                As alterações são salvas automaticamente nesta máquina.
              </p>
            </aside>

            <section className="settings-content">
              <header className="settings-section-head">
                <span>{copy.eyebrow}</span>
                <h2>{copy.title}</h2>
                <p>{copy.text}</p>
              </header>

              <div className={`settings-section-body section-${section}`}>
                {section === 'appearance' && (
                  <>
                    <GuiPanelErrorBoundary
                      paneId="settings:appearance"
                      label="a acessibilidade do Synkora"
                    >
                      <AccessibilitySettings />
                    </GuiPanelErrorBoundary>
                    <GuiPanelErrorBoundary
                      paneId="settings:chat-writing"
                      label="a escrita do chat"
                    >
                      <ChatWritingSettings />
                    </GuiPanelErrorBoundary>
                    <GuiPanelErrorBoundary
                      paneId="settings:chat-notices"
                      label="os avisos do chat"
                    >
                      <ChatNoticeSettings />
                    </GuiPanelErrorBoundary>
                    <GuiPanelErrorBoundary
                      paneId="settings:board-notices"
                      label="os avisos do Board"
                    >
                      <NoticeSettings />
                    </GuiPanelErrorBoundary>
                    <GuiPanelErrorBoundary
                      paneId="settings:rail-groups"
                      label="os grupos no rail"
                    >
                      <RailGroupSettings />
                    </GuiPanelErrorBoundary>
                  </>
                )}
                {section === 'accounts' && (
                  <GuiPanelErrorBoundary paneId="settings:accounts" label="as contas">
                    <SeatDeck />
                  </GuiPanelErrorBoundary>
                )}
                {section === 'skills' && (
                  <GuiPanelErrorBoundary paneId="settings:skills" label="a biblioteca de skills">
                    <SkillsSettings />
                  </GuiPanelErrorBoundary>
                )}
                {section === 'voice' && (
                  <GuiPanelErrorBoundary paneId="settings:voice" label="as configurações do SynVoice">
                    <SynVoiceMicrophoneSettings />
                  </GuiPanelErrorBoundary>
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
