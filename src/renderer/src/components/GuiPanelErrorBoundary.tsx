import { Component, type ErrorInfo, type ReactNode } from 'react'
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
      this.setState({ failed: false, retry: this.state.retry + 1 })
    }
  }

  private retry = (): void => {
    this.setState((state) => ({ failed: false, retry: state.retry + 1 }))
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <section className="gui-panel-failure" role="alert" aria-live="assertive">
        <div className="gui-panel-failure-mark" aria-hidden="true">
          !
        </div>
        <div className="gui-panel-failure-copy">
          <strong>{this.props.label ?? 'este painel'} encontrou um erro</strong>
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
