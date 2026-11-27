import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/fonts.css'
import './styles/global.css'
import './styles/screens.css'
import { App } from './App'
import { AppStatus } from './features/pwa/AppStatus'
import { EdgeSwipeBack } from './components/EdgeSwipeBack'
import { TabSwipe } from './components/TabSwipe'
import { SuccessTick } from './components/ui/SuccessTick'
import { startServiceWorker } from './features/pwa/serviceWorker'
import { startTopShade } from './lib/topShade'
import { startPinBottomBars } from './lib/pinBottomBars'

startServiceWorker()

startTopShade()
startPinBottomBars()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <AppStatus />
    <SuccessTick />
    <EdgeSwipeBack />
    <TabSwipe />
  </StrictMode>
)
