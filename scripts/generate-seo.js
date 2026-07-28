// Generates public/sitemap.xml, public/photos/*.html, public/photos/index.html,
// and public/privacy-policy.html from src/Templates/*.json + src/seoContent.json.
// Runs before both `npm start` and `npm run build` (see package.json / vercel.json).
// These are build artifacts - see .gitignore - so the only source of truth to edit
// is src/seoContent.json (copy) and src/Templates/*.json (dimensions).

const fs = require('fs')
const path = require('path')

const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development'
require('dotenv').config({ path: path.join(__dirname, '..', envFile) })
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

const ROOT = path.join(__dirname, '..')
const TEMPLATES_DIR = path.join(ROOT, 'src', 'Templates')
const PUBLIC_DIR = path.join(ROOT, 'public')
const PHOTOS_DIR = path.join(PUBLIC_DIR, 'photos')
const MM_PER_INCH = 25.4

const SITE_URL = (process.env.REACT_APP_SITE_URL || 'http://localhost:3000').replace(/\/+$/, '')

const seoContent = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'seoContent.json'), 'utf8'))

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function loadTemplates() {
  return fs.readdirSync(TEMPLATES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf8')))
}

function deriveSpec(template) {
  const widthMm = parseFloat(template.width)
  const heightMm = parseFloat(template.height)
  const dpi = parseFloat(template.dpi)
  return {
    widthMm,
    heightMm,
    // 1 decimal place: at 2 decimals, template mm values that approximate a round
    // inch size (e.g. US 51mm ~= 2in) render as "2.01in", which reads as a
    // contradiction next to hand-written copy that says "2x2 inches".
    widthIn: (widthMm / MM_PER_INCH).toFixed(1),
    heightIn: (heightMm / MM_PER_INCH).toFixed(1),
    // Math.trunc (not round) to match the app's own export pixel math exactly (see
    // the width/height calculation in src/App.js's template-selection handler).
    widthPx: Math.trunc((widthMm / MM_PER_INCH) * dpi),
    heightPx: Math.trunc((heightMm / MM_PER_INCH) * dpi),
    dpi,
    maxSizeKb: template.size,
    format: (template.format || 'jpg').toUpperCase(),
  }
}

function renderLayout({ title, description, canonicalPath, ldJson, bodyHtml }) {
  const canonicalUrl = `${SITE_URL}${canonicalPath}`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${canonicalUrl}">
<link rel="icon" href="/favicon.ico">
<link rel="stylesheet" href="/seo.css">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${canonicalUrl}">
<meta property="og:type" content="article">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
${(ldJson || []).map((obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`).join('\n')}
</head>
<body>
<header class="seo-header">
  <a class="seo-brand" href="/">Passport &amp; Visa Photo Maker</a>
  <a href="/">Open the photo editor &rarr;</a>
</header>
<main>
${bodyHtml}
</main>
<footer class="seo-footer">
  <span>&copy; ${new Date().getFullYear()} Passport &amp; Visa Photo Maker</span>
  <span><a href="/photos/">All countries</a> &middot; <a href="/privacy-policy.html">Privacy Policy</a></span>
</footer>
</body>
</html>
`
}

function renderPhotoPage(template, content) {
  const spec = deriveSpec(template)
  const canonicalPath = `/photos/${content.slug}.html`
  const ctaHref = `/?template=${encodeURIComponent(template.title)}`

  const faqLdEntities = content.faqs.map((f) => ({
    '@type': 'Question',
    name: f.q,
    acceptedAnswer: { '@type': 'Answer', text: f.a },
  }))

  const ldJson = [
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faqLdEntities,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_URL}/` },
        { '@type': 'ListItem', position: 2, name: 'All countries', item: `${SITE_URL}/photos/` },
        { '@type': 'ListItem', position: 3, name: content.h1, item: `${SITE_URL}${canonicalPath}` },
      ],
    },
  ]

  const bodyHtml = `
<nav class="seo-breadcrumb"><a href="/">Home</a> / <a href="/photos/">All countries</a> / ${escapeHtml(content.h1)}</nav>
<h1>${escapeHtml(content.h1)}</h1>
${content.intro.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n')}
<table class="seo-spec">
  <tbody>
    <tr><th>Photo size</th><td>${spec.widthMm} &times; ${spec.heightMm} mm (${spec.widthIn}" &times; ${spec.heightIn}")</td></tr>
    <tr><th>Resolution</th><td>${spec.dpi} DPI (${spec.widthPx} &times; ${spec.heightPx} px)</td></tr>
    <tr><th>Max file size</th><td>${spec.maxSizeKb} KB</td></tr>
    <tr><th>Format</th><td>${spec.format}</td></tr>
  </tbody>
</table>
<a class="seo-cta" href="${ctaHref}">Make this photo now &rarr;</a>
<h2>Frequently asked questions</h2>
${content.faqs.map((f) => `<div class="seo-faq-item"><h3>${escapeHtml(f.q)}</h3><p>${escapeHtml(f.a)}</p></div>`).join('\n')}
${content.sourceUrl
      ? `<p class="seo-source-note">Source: <a target="_blank" rel="noreferrer" href="${content.sourceUrl}">${escapeHtml(content.sourceLabel)}</a>. Requirements change over time - always confirm the current specification before submitting.</p>`
      : `<p class="seo-source-note">This document type does not have one consistently published official specification - always confirm the exact requirement with the office processing your application.</p>`
    }
`

  return renderLayout({
    title: content.metaTitle,
    description: content.metaDescription,
    canonicalPath,
    ldJson,
    bodyHtml,
  })
}

function renderIndexPage(entries) {
  const ldJson = [{
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: entries.map((e, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: e.content.h1,
      url: `${SITE_URL}/photos/${e.content.slug}.html`,
    })),
  }]

  const bodyHtml = `
<nav class="seo-breadcrumb"><a href="/">Home</a> / All countries</nav>
<h1>Passport &amp; Visa Photo Requirements by Country</h1>
<p>Pick a country or document type below for its exact photo size, background, and DPI requirements, then jump straight into the free photo editor.</p>
<ul class="seo-index-list">
${entries.map((e) => `  <li><a href="/photos/${e.content.slug}.html">${escapeHtml(e.content.h1)}</a></li>`).join('\n')}
</ul>
`

  return renderLayout({
    title: 'Passport & Visa Photo Requirements by Country - Free Online Maker',
    description: 'Exact passport and visa photo size, background, and DPI requirements for 13 countries and document types, with a free online photo maker for each.',
    canonicalPath: '/photos/',
    ldJson,
    bodyHtml,
  })
}

function renderPrivacyPolicyPage() {
  const bodyHtml = `
<nav class="seo-breadcrumb"><a href="/">Home</a> / Privacy Policy</nav>
<h1>Privacy Policy</h1>
<p>This page explains what happens to your data when you use Passport &amp; Visa Photo Maker.</p>
<h2>Your photos</h2>
<p>Your photo is processed entirely inside your own browser. It is never uploaded to, or stored on, any server operated by this site. Background removal and face alignment run locally using an in-browser AI model; the only network requests they make are to download the (non-photo) model files themselves, not your photo.</p>
<h2>Analytics</h2>
<p>This site uses Google Analytics (GA4) to understand aggregate traffic, such as which pages are visited and which browser/device is used. This does not include your photos. You can decline non-essential cookies using the cookie banner shown on your first visit.</p>
<h2>Advertising</h2>
<p>This site may show ads served by Google AdSense or a similar ad network. These networks may use cookies to personalize ads based on your visits to this and other sites. Where required (for example, in the UK and EEA), ad personalization only occurs after you consent via the cookie banner; you can decline and still use every feature of the site.</p>
<h2>Cookies</h2>
<p>Cookies on this site are limited to analytics and, if enabled, ad personalization as described above. No cookie is required for the photo editor itself to work.</p>
<h2>Contact</h2>
<p>Questions about this policy can be raised via the <a href="https://github.com/georgeputhean/passport-photo-maker/issues" target="_blank" rel="noreferrer">issues page</a> on GitHub.</p>
`

  return renderLayout({
    title: 'Privacy Policy - Passport & Visa Photo Maker',
    description: 'How Passport & Visa Photo Maker handles your photos, analytics, cookies, and ads. Photos are processed locally in your browser and never uploaded.',
    canonicalPath: '/privacy-policy.html',
    ldJson: [],
    bodyHtml,
  })
}

function renderSitemap(entries) {
  const urls = [
    { loc: `${SITE_URL}/`, priority: '1.0' },
    { loc: `${SITE_URL}/photos/`, priority: '0.8' },
    ...entries.map((e) => ({ loc: `${SITE_URL}/photos/${e.content.slug}.html`, priority: '0.9' })),
    { loc: `${SITE_URL}/privacy-policy.html`, priority: '0.3' },
  ]

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u.loc}</loc><priority>${u.priority}</priority></url>`).join('\n')}
</urlset>
`
}

function updateRobotsTxt() {
  const robotsPath = path.join(PUBLIC_DIR, 'robots.txt')
  const existing = fs.readFileSync(robotsPath, 'utf8')
  const lines = existing.split(/\r\n|\n/).filter((line) => !line.trim().startsWith('Sitemap:'))
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
  const updated = `${lines.join('\n')}\n\nSitemap: ${SITE_URL}/sitemap.xml\n`
  fs.writeFileSync(robotsPath, updated)
}

function main() {
  const templates = loadTemplates()
  const entries = templates
    .map((template) => {
      const content = seoContent[template.title]
      if (!content) {
        console.warn(`[generate-seo] No src/seoContent.json entry for template "${template.title}" - skipping its landing page.`)
        return null
      }
      return { template, content }
    })
    .filter(Boolean)

  fs.mkdirSync(PHOTOS_DIR, { recursive: true })

  entries.forEach(({ template, content }) => {
    fs.writeFileSync(path.join(PHOTOS_DIR, `${content.slug}.html`), renderPhotoPage(template, content))
  })

  fs.writeFileSync(path.join(PHOTOS_DIR, 'index.html'), renderIndexPage(entries))
  fs.writeFileSync(path.join(PUBLIC_DIR, 'privacy-policy.html'), renderPrivacyPolicyPage())
  fs.writeFileSync(path.join(PUBLIC_DIR, 'sitemap.xml'), renderSitemap(entries))
  updateRobotsTxt()

  console.log(`[generate-seo] Generated ${entries.length} landing pages + index + sitemap + privacy policy (SITE_URL=${SITE_URL}).`)
}

main()
