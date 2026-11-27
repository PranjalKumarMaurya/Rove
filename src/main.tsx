import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/fonts.css'
import './styles/global.css'
import { App } from './App'
import { AppStatus } from './features/pwa/AppStatus'
import { EdgeSwipeBack } from './components/EdgeSwipeBack'
import { SuccessTick } from './components/ui/SuccessTick'
import { startServiceWorker } from './features/pwa/serviceWorker'

startServiceWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <AppStatus />
    <SuccessTick />
    <EdgeSwipeBack />
  </StrictMode>
)
