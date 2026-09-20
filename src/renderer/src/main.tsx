import ReactDOM from 'react-dom/client'
import './global.css'

const query = new URLSearchParams(window.location.search)
if (query.get('view') === 'mobile-phone') {
  // A phone has only its scoped bridge. Do not load App, the dev mock or the
  // owner-window watchdog in this restricted renderer.
  document.documentElement.classList.add('mobile-phone-page')
  document.body.classList.add('mobile-phone-page')
  window.addEventListener('dragover', event => event.preventDefault())
  window.addEventListener('drop', event => event.preventDefault())
  void import('./components/MobilePhone').then(({ default: MobilePhone }) => {
    ReactDOM.createRoot(document.getElementById('root')!).render(<MobilePhone windowId={query.get('windowId') ?? ''} />)
  })
} else {
  void import('./mainApp')
}
