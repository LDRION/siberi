import { StrictMode } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import './fonts.css'
import './index.css'
import './styles/finarch.css'
import App from './App.jsx'

// react-snap снимает лендинг вместе с классами на <body> и запекает их в
// dist/index.html (<body class="sb-landing">). Этот же файл SPA отдаёт на всех
// роутах, а снять класс некому: на /chat, /dashboard и прочих Landing не
// монтируется, его cleanup не вызывается — в итоге токены лендинга перебивают
// токены кабинета. На самом лендинге класс вернёт Landing своим эффектом.
if (window.location.pathname !== '/about') {
  document.body.classList.remove('sb-landing')
}

const rootEl = document.getElementById('root')
const app = (
  <StrictMode>
    <App />
  </StrictMode>
)

// react-snap пре-рендерит лендинг/юр-страницы для SEO. Они перегружены
// клиентскими эффектами (звёзды/робот/coverflow), которые правят DOM после
// снимка — из-за этого гидратация ловит несовпадения (#418). React сам их
// корректно перерисовывает; onRecoverableError гасит консольный шум.
if (rootEl.hasChildNodes()) {
  hydrateRoot(rootEl, app, { onRecoverableError: () => {} })
} else {
  createRoot(rootEl).render(app)
}
