import ReactDOM from 'react-dom/client'
import App from './App'
import { installDevMock } from './devMock'
import './global.css'

if (import.meta.env.DEV) installDevMock()

// Sem StrictMode: o double-mount de dev criaria/mataria PTYs em sequência,
// derrubando sessões reais de CLI a cada hot reload.
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
