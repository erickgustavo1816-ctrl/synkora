import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react'
import './GuiPanelErrorBoundary.css'

interface GuiPanelErrorBoundaryProps {
  paneId: string
  label?: string
  children: ReactNode
  onClose?: () => void
}

interface GuiPanelErrorBoundaryState {
  failed: boolean
  retry: number
}

function safePanelLabel(label: string | undefined): string {
  const normalized = (typeof label === 'string' ? label : '')
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  return normalized ? normalized.slice(0, 120) : 'este painel'
}

/**
 * P29: um defeito de renderização pertence ao painel que o produziu. O texto
 * deliberadamente não ecoa detalhes da exceção, que podem carregar caminhos
 * ou conteúdo da conversa.
 */
export default class GuiPanelErrorBoundary extends Component<
  GuiPanelErrorBoundaryProps,
  GuiPanelErrorBoundaryState
> {
  state: GuiPanelErrorBoundaryState = { failed: false, retry: 0 }

  static getDerivedStateFromError(): Partial<GuiPanelErrorBoundaryState> {
    return { failed: true }
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // A falha já fica contida e visível. Não registrar stack/conversa no log.
  }

  componentDidUpdate(previous: GuiPanelErrorBoundaryProps): void {
    if (previous.paneId !== this.props.paneId && this.state.failed) {
      this.setState((state) => ({ failed: false, retry: state.retry + 1 }))
    }
  }

  private retry = (): void => {
    this.setState((state) => ({ failed: false, retry: state.retry + 1 }))
  }

  render(): ReactNode {
    // A retry is a real remount, not only a second render of a child that may
    // have kept poisoned local state. The pane identity is part of the key so
    // swapping a pane recovers even when the boundary instance is reused.
    if (!this.state.failed) {
      return <Fragment key={`${this.props.paneId}:${this.state.retry}`}>{this.props.children}</Fragment>
    }
    const label = safePanelLabel(this.props.label)
    return (
      <section className="gui-panel-failure" role="alert" aria-live="assertive">
        <div className="gui-panel-failure-mark" aria-hidden="true">
          !
        </div>
        <div className="gui-panel-failure-copy">
          <strong>{label} encontrou um erro</strong>
          <span>o restante do Synkora continua funcionando</span>
        </div>
        <div className="gui-panel-failure-actions">
          <button type="button" className="term-btn" onClick={this.retry}>
            tentar de novo
          </button>
          {this.props.onClose && (
            <button type="button" className="term-btn ghost-dim" onClick={this.props.onClose}>
              fechar painel
            </button>
          )}
        </div>
      </section>
    )
  }
}
