import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './styles.css'
import './overrides.css'

if ('serviceWorker' in navigator) {
  let hadController = Boolean(navigator.serviceWorker.controller)
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) {
      hadController = true
      return
    }
    window.location.reload()
  })
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
