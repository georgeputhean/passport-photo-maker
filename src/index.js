import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import App from './App'
import reportWebVitals from './reportWebVitals'

// public/index.html ships a static, crawler-visible content block (h1, country
// links, FAQs) for search/AI engines and no-JS clients - see the SEO_CONTENT
// markers there. Real visitors get the app instead, so remove it as soon as
// JS actually runs, before the app paints.
document.getElementById('seo-content')?.remove()

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
