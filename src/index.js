import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import App from './App'
import reportWebVitals from './reportWebVitals'

// public/index.html ships a static, crawler-visible content block (h1, country
// links, FAQs) for search/AI engines - see the SEO_CONTENT markers there. It
// used to be removed once the app mounted, on the assumption that crawlers
// only ever see the pre-JS HTML - but Google (and Bing/GPTBot/etc.) indexes
// the rendered DOM, so deleting it here deleted it from the index too. It
// stays in the page permanently now, below the editor in document order.

const root = ReactDOM.createRoot(document.getElementById('root'))

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals()
