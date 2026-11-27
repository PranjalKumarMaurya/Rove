import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// fonts.css first: its remote @import must lead the bundled stylesheet. Then the type tokens, before everything else.
import './styles/fonts.css'
import './styles/type.css'
import './styles/global.css'
import './styles/screens.css'
import { App } from './App'
import { AppStatus } from './features/pwa/AppStatus'
import { EdgeSwipeBack } from './components/EdgeSwipeBack'
import { TabSwipe } from './components/TabSwipe'
import { SuccessTick } from './components/ui/SuccessTick'
import { startServiceWorker } from './features/pwa/serviceWorker'
import { startTopShade } from './lib/topShade'
import { startTopBar } from './lib/topBar'
import { startPinBottomBars } from './lib/pinBottomBars'
import { applyTextSize, readTextSize } from './lib/textSize'

// The saved Text size and Bold text, before anything renders, so text never jumps size.
applyTextSize(readTextSize())

startServiceWorker()

startTopShade()
startTopBar()
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
