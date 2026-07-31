// Generates public/sitemap.xml, public/photos/*.html, public/photos/index.html,
// and public/privacy-policy.html from src/Templates/*.json + src/seoContent.json.
// Runs before both `npm start` and `npm run build` (see package.json / vercel.json).
// These are build artifacts - see .gitignore - so the only source of truth to edit
// is src/seoContent.json (copy) and src/Templates/*.json (dimensions).

const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development'
require('dotenv').config({ path: path.join(__dirname, '..', envFile) })
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

const ROOT = path.join(__dirname, '..')
const TEMPLATES_DIR = path.join(ROOT, 'src', 'Templates')
const PUBLIC_DIR = path.join(ROOT, 'public')
const PHOTOS_DIR = path.join(PUBLIC_DIR, 'photos')
const OG_DIR = path.join(PUBLIC_DIR, 'og')
const MM_PER_INCH = 25.4

const SITE_URL = (process.env.REACT_APP_SITE_URL || 'http://localhost:3000').replace(/\/+$/, '')
const BUILD_DATE = new Date().toISOString().slice(0, 10)

// Ads and affiliate links are opt-in via env vars (same "blank disables" convention
// as REACT_APP_GA_MEASUREMENT_ID / REACT_APP_ADSENSE_CLIENT_ID below). With no valid
// AdSense client ID set, production builds ship zero ad markup and zero tracking
// script - see renderAdSlot(). IDs are format-validated rather than just HTML-escaped
// since the client ID is also interpolated into a JS string context (see
// consentBanner()), where HTML-entity escaping would not be the correct escaping.
// Affiliate links fall back to a plain informational URL when no partner deep link
// is configured - see AFFILIATE_PARTNERS.
const rawClientId = process.env.REACT_APP_ADSENSE_CLIENT_ID || ''
const ADSENSE_CLIENT_ID = /^ca-pub-\d+$/.test(rawClientId) ? rawClientId : ''
if (rawClientId && !ADSENSE_CLIENT_ID) {
  console.warn(`[generate-seo] REACT_APP_ADSENSE_CLIENT_ID "${rawClientId}" doesn't look like "ca-pub-<digits>" - ignoring it, ads stay disabled.`)
}

function validSlot(raw) {
  return /^\d+$/.test(raw || '') ? raw : ''
}

const ADSENSE_SLOTS = {
  incontent: validSlot(process.env.REACT_APP_ADSENSE_SLOT_INCONTENT),
  footer: validSlot(process.env.REACT_APP_ADSENSE_SLOT_FOOTER),
}

const AFFILIATE_PARTNERS = [
  { name: 'Walgreens', envVar: 'REACT_APP_AFFILIATE_WALGREENS_URL', fallbackUrl: 'https://www.walgreens.com/topic/passport-photos.jsp' },
  { name: 'CVS', envVar: 'REACT_APP_AFFILIATE_CVS_URL', fallbackUrl: 'https://www.cvs.com/content/passport-photos' },
  { name: 'Walmart', envVar: 'REACT_APP_AFFILIATE_WALMART_URL', fallbackUrl: 'https://www.walmart.com/cp/photo-center-passport-photos/1078557' },
  { name: 'Shutterfly', envVar: 'REACT_APP_AFFILIATE_SHUTTERFLY_URL', fallbackUrl: 'https://www.shutterfly.com/passport-photos' },
]

const seoContent = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'seoContent.json'), 'utf8'))
const aiEditingPolicy = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'aiEditingPolicy.json'), 'utf8'))

const GENERIC_CHECKLIST = [
  'Neutral facial expression, mouth closed, both eyes open',
  'Face the camera directly, with no head tilt',
  'No hats or head coverings, except for religious or medical reasons - your full face must still be visible',
  'A recent photo, typically taken within the last 6 months',
  'A plain, evenly lit background with no shadows, patterns, or other people or objects',
  'Glasses are discouraged or restricted by a growing number of countries due to glare - check the official source below for this document specifically',
]

const AT_HOME_STEPS = [
  'Stand about 3-6 feet in front of a plain, light-colored wall with no shadow falling behind you.',
  'Use even, natural light facing you - a window works well. Avoid harsh overhead light, backlighting, or a direct flash, which all cast shadows.',
  'Hold the camera at eye level, at arm’s length or propped on a stand, and look straight into it.',
  'Keep a neutral expression, mouth closed, both eyes open, and remove hats or sunglasses.',
  'Take a few shots, then upload the sharpest one here - cropping to the exact size, and background removal if you use it, are handled automatically.',
]

// Renders only an empty, labeled placeholder container - never an <ins> tag and
// never an adsbygoogle.js push. Real ad markup is created client-side by
// consentBanner()'s loadAds(), and only once the visitor has actually granted
// consent, so a user who declines never has an orphaned/empty ad slot rendered.
function renderAdSlot(position) {
  const slotId = ADSENSE_SLOTS[position]
  const configured = ADSENSE_CLIENT_ID && slotId
  if (!configured) {
    // Nothing to reserve space for in a real build. In local dev (no env vars set
    // at all) show a dev-only affordance so the layout is previewable.
    if (process.env.NODE_ENV === 'production') return ''
    return `<div class="seo-ad-slot" data-position="${position}"><span class="seo-ad-label">Advertisement (unconfigured - dev preview only)</span></div>`
  }
  return `<div class="seo-ad-slot" data-position="${position}" data-ad-slot="${escapeHtml(slotId)}"><span class="seo-ad-label">Advertisement</span></div>`
}

function renderAffiliateSection() {
  const links = AFFILIATE_PARTNERS.map((p) => {
    const url = process.env[p.envVar] || p.fallbackUrl
    return `<li><a href="${escapeHtml(url)}" target="_blank" rel="sponsored noopener">${escapeHtml(p.name)}</a></li>`
  }).join('\n')

  return `
<h2>Get it printed nearby</h2>
<p class="seo-disclosure">We may earn a commission if you buy prints through the links below, at no extra cost to you. It doesn't change our recommendations or requirement data.</p>
<ul class="seo-affiliate-list">
${links}
</ul>
`
}

function consentAndAdsHead() {
  if (!ADSENSE_CLIENT_ID) return ''
  return `
<script>
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('consent', 'default', {
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
  analytics_storage: 'denied'
});
</script>`
}

function consentBanner() {
  if (!ADSENSE_CLIENT_ID) return ''
  // ADSENSE_CLIENT_ID is validated above against /^ca-pub-\d+$/, so it's safe to
  // interpolate directly into this JS string context (HTML-entity escaping would be
  // the wrong escaping here, since this lands in JS, not an HTML attribute).
  return `
<div class="seo-consent-banner" id="seo-consent-banner" hidden>
  <p>This site uses cookies for analytics and, if you agree, ad personalization. See our <a href="/privacy-policy.html">Privacy Policy</a>.</p>
  <div class="seo-consent-actions">
    <button type="button" id="seo-consent-decline">Decline</button>
    <button type="button" id="seo-consent-accept">Accept</button>
  </div>
</div>
<script>
(function () {
  var KEY = 'seo-ad-consent';
  var banner = document.getElementById('seo-consent-banner');

  // Only ever called after consent is granted. Builds the real <ins> ad units
  // client-side and pushes them, so a declined/pending visitor never has ad
  // markup sitting in the DOM with no library behind it.
  function loadAds() {
    document.querySelectorAll('.seo-ad-slot[data-ad-slot]').forEach(function (el) {
      if (el.querySelector('ins.adsbygoogle')) return;
      var ins = document.createElement('ins');
      ins.className = 'adsbygoogle';
      ins.style.display = 'block';
      ins.setAttribute('data-ad-client', '${ADSENSE_CLIENT_ID}');
      ins.setAttribute('data-ad-slot', el.getAttribute('data-ad-slot'));
      ins.setAttribute('data-ad-format', 'auto');
      ins.setAttribute('data-full-width-responsive', 'true');
      el.appendChild(ins);
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    });
    if (document.querySelector('script[data-adsbygoogle-loader]')) return;
    var s = document.createElement('script');
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.dataset.adsbygoogleLoader = 'true';
    s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT_ID}';
    document.head.appendChild(s);
  }
  var stored = localStorage.getItem(KEY);
  if (stored === 'granted') {
    gtag('consent', 'update', { ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted', analytics_storage: 'granted' });
    loadAds();
  } else if (stored !== 'denied') {
    banner.hidden = false;
  }
  document.getElementById('seo-consent-accept').addEventListener('click', function () {
    localStorage.setItem(KEY, 'granted');
    gtag('consent', 'update', { ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted', analytics_storage: 'granted' });
    banner.hidden = true;
    loadAds();
  });
  document.getElementById('seo-consent-decline').addEventListener('click', function () {
    localStorage.setItem(KEY, 'denied');
    banner.hidden = true;
  });
})();
</script>`
}

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

// Text-only (no emoji - color-emoji fonts aren't reliably available in a
// headless build container). font-family is a named-font stack, not just the
// generic "sans-serif" keyword: on this system, librsvg (which sharp uses
// for SVG rasterization) resolves the bare "sans-serif" keyword to a SERIF
// font (confirmed by rendering a test image) but resolves named fonts
// correctly. "Liberation Sans" is metric-compatible with Arial and commonly
// preinstalled on Linux build images; "sans-serif" stays as the last-resort
// fallback. Not verified on Vercel's actual Linux build container - check a
// generated /og/*.png after the first deploy.
function renderOgSvg(content, spec) {
  const title = escapeHtml(content.h1)
  const specLine = `${spec.widthMm} × ${spec.heightMm} mm (${spec.widthIn}" × ${spec.heightIn}") · ${spec.dpi} DPI`
  return `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="630" fill="#0f172a"/>
  <text x="80" y="120" font-family="Arial, Helvetica, Liberation Sans, sans-serif" font-size="30" font-weight="700" fill="#93c5fd">Passport &amp; Visa Photo Maker</text>
  <text x="80" y="280" font-family="Arial, Helvetica, Liberation Sans, sans-serif" font-size="54" font-weight="700" fill="#ffffff">
${wrapSvgText(title, 22).map((line, i) => `    <tspan x="80" dy="${i === 0 ? 0 : 64}">${escapeHtml(line)}</tspan>`).join('\n')}
  </text>
  <text x="80" y="460" font-family="Arial, Helvetica, Liberation Sans, sans-serif" font-size="34" fill="#e2e8f0">${escapeHtml(specLine)}</text>
  <text x="80" y="560" font-family="Arial, Helvetica, Liberation Sans, sans-serif" font-size="26" fill="#94a3b8">Free · processed in your browser, never uploaded</text>
</svg>`
}

// Naive word-wrap for SVG <tspan> lines - country titles run long enough
// ("Australia Passport & Visa Photo Size and Requirements") to overflow a
// single 1200px-wide line at a readable font size.
function wrapSvgText(text, maxCharsPerLine) {
  const words = text.replace(/&amp;/g, '&').split(' ')
  const lines = []
  let current = ''
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length > maxCharsPerLine && current) {
      lines.push(current)
      current = word
    } else {
      current = next
    }
  }
  if (current) lines.push(current)
  return lines.slice(0, 3)
}

async function generateOgImage(content, spec) {
  const svg = renderOgSvg(content, spec)
  await sharp(Buffer.from(svg)).png().toFile(path.join(OG_DIR, `${content.slug}.png`))
}

function renderLayout({ title, description, canonicalPath, ldJson, bodyHtml, ogImagePath }) {
  const canonicalUrl = `${SITE_URL}${canonicalPath}`
  const ogImageUrl = `${SITE_URL}${ogImagePath || '/logo512.png'}`
  const twitterCard = ogImagePath ? 'summary_large_image' : 'summary'
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
<meta property="og:image" content="${ogImageUrl}">
<meta name="twitter:card" content="${twitterCard}">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${ogImageUrl}">
${(ldJson || []).map((obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`).join('\n')}${consentAndAdsHead()}
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
  <span><a href="/photos/">All countries</a> &middot; <a href="/about.html">About</a> &middot; <a href="/methodology.html">Methodology</a> &middot; <a href="/contact.html">Contact</a> &middot; <a href="/privacy-policy.html">Privacy Policy</a></span>
</footer>${consentBanner()}
</body>
</html>
`
}

function renderAlterationPolicy(template) {
  const policy = aiEditingPolicy[template.title]
  const note = policy?.restricted
    ? policy.note
    : 'We have not found a published rule specifically banning background removal or other AI editing for this document as of this writing - but policies are changing across the industry, and getting it wrong can mean a rejected application. Always check the official source below for the current rule before using background removal, and when in doubt, use only cropping and resizing.'
  return `
<h2>Can you use AI background removal for this photo?</h2>
<p>${escapeHtml(note)}</p>
`
}

function renderChecklist() {
  return `
<h2>General photo rules</h2>
<p>These apply broadly, but always confirm the specifics for this document on the official source below.</p>
<ul class="seo-checklist">
${GENERIC_CHECKLIST.map((item) => `  <li>${escapeHtml(item)}</li>`).join('\n')}
</ul>
`
}

function renderAtHomeSteps() {
  return `
<h2>How to take this photo at home</h2>
<ol class="seo-steps">
${AT_HOME_STEPS.map((step) => `  <li>${escapeHtml(step)}</li>`).join('\n')}
</ol>
<p>Many governments accept a digital photo upload for online applications as well as a printed photo for in-person or mail applications - check the official source below for which your application needs. This tool exports both a single photo file and a 4x6 print sheet, so either way you're covered.</p>
`
}

function renderRelatedCountries(entries, content) {
  const rest = entries.filter((e) => e.content.slug !== content.slug)
  // Rotate the starting point by this page's own position instead of always
  // slicing the first 6 - otherwise every page links the same handful of
  // countries and the rest get almost no internal links.
  const startIndex = entries.findIndex((e) => e.content.slug === content.slug)
  const others = rest.length <= 6
    ? rest
    : Array.from({ length: 6 }, (_, i) => rest[(startIndex + i) % rest.length])
  if (others.length === 0) return ''
  return `
<h2>Other countries and documents</h2>
<ul class="seo-index-list">
${others.map((e) => `  <li><a href="/photos/${e.content.slug}.html">${escapeHtml(e.content.h1)}</a></li>`).join('\n')}
</ul>
`
}

function renderPhotoPage(template, content, entries) {
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
    {
      '@context': 'https://schema.org',
      '@type': 'HowTo',
      name: `How to take a ${content.h1}`,
      step: AT_HOME_STEPS.map((step) => ({ '@type': 'HowToStep', text: step })),
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
${renderAlterationPolicy(template)}
${renderChecklist()}
${renderAtHomeSteps()}
${renderAffiliateSection()}
${renderAdSlot('incontent')}
<h2>Frequently asked questions</h2>
${content.faqs.map((f) => `<div class="seo-faq-item"><h3>${escapeHtml(f.q)}</h3><p>${escapeHtml(f.a)}</p></div>`).join('\n')}
${content.sourceUrl
      ? `<p class="seo-source-note">Source: <a target="_blank" rel="noreferrer" href="${content.sourceUrl}">${escapeHtml(content.sourceLabel)}</a>. Requirements change over time - always confirm the current specification before submitting.</p>`
      : `<p class="seo-source-note">This document type does not have one consistently published official specification - always confirm the exact requirement with the office processing your application.</p>`
    }
${renderRelatedCountries(entries, content)}
${renderAdSlot('footer')}
`

  return renderLayout({
    title: content.metaTitle,
    description: content.metaDescription,
    canonicalPath,
    ldJson,
    bodyHtml,
    ogImagePath: `/og/${content.slug}.png`,
  })
}

const HOME_FAQS = [
  {
    q: 'Is this passport photo maker actually free?',
    a: 'Yes. The editor, background removal, and the multi-copy 4x6 print layout are all free, with no signup, no watermark, and no paywalled export.',
  },
  {
    q: 'Do my photos get uploaded anywhere?',
    a: 'No. Cropping, background removal, and face alignment all run locally in your browser using in-browser AI models. Your photo itself is never sent to a server.',
  },
  {
    q: 'Which countries and documents are supported?',
    a: 'US, UK, Canada (passport and visa), India, China (passport/visa and travel document), Japan, Malaysia, Germany, Australia, Mexico TN visa, and Spain - each with its own exact size, DPI, and background requirements.',
  },
  {
    q: 'Will the background removal always be accepted?',
    a: 'Not necessarily. As of 2026, the U.S. State Department’s guidance says not to alter your photo with software, filters, or AI, including background replacement - only cropping, resizing, and similar format changes are safe for a US application. Rules differ by country, so check the official source linked on each country’s page before submitting.',
  },
  {
    q: 'What size and format do I get?',
    a: 'The exact millimeter/inch dimensions and DPI required for the document you pick, exported as a single photo and, where useful, a 4x6 print sheet with multiple copies.',
  },
  {
    q: 'Do I need to install anything?',
    a: 'No. It runs entirely in your browser on desktop or mobile - no app download, no account.',
  },
]

function renderHomepageSeoBlock(entries) {
  const countryLinks = entries
    .map((e) => `    <li><a href="/photos/${e.content.slug}.html">${escapeHtml(e.content.h1)}</a></li>`)
    .join('\n')

  const faqHtml = HOME_FAQS
    .map((f) => `  <div class="seo-faq-item"><h3>${escapeHtml(f.q)}</h3><p>${escapeHtml(f.a)}</p></div>`)
    .join('\n')

  return `<div id="seo-content">
<h1>Passport &amp; Visa Photo Maker</h1>
<p>Create a passport or visa photo online, free, for ${entries.length} countries and document types. Upload a photo, and this tool crops it to the exact size and DPI required, with an option to remove the background automatically - all processed locally in your browser, never uploaded to a server.</p>
<h2>How it works</h2>
<ol class="seo-steps">
  <li>Pick your country or document type below, or from the editor.</li>
  <li>Upload a photo and, if you want, remove the background with one click.</li>
  <li>Download the correctly sized photo, or a 4x6 print sheet with multiple copies.</li>
</ol>
<h2>Your photo never leaves your device</h2>
<p>Background removal and face alignment run on in-browser AI models, not a server. The only network activity is downloading the (non-photo) model files themselves. See the <a href="/privacy-policy.html">Privacy Policy</a> for details.</p>
<h2>Supported countries and documents</h2>
<ul class="seo-index-list">
${countryLinks}
</ul>
<a class="seo-cta" href="/photos/">See full requirements for every country &rarr;</a>
<h2>Frequently asked questions</h2>
${faqHtml}
<p class="seo-source-note">Photo requirements are set by each country’s government and can change. Always confirm the current specification on the official source linked from that country’s page before submitting.</p>
</div>`
}

function updateIndexHtml(entries) {
  const indexPath = path.join(PUBLIC_DIR, 'index.html')
  const html = fs.readFileSync(indexPath, 'utf8')
  const block = renderHomepageSeoBlock(entries)
  const updated = html.replace(
    /<!-- SEO_CONTENT_START -->[\s\S]*<!-- SEO_CONTENT_END -->/,
    `<!-- SEO_CONTENT_START -->\n${block}\n  <!-- SEO_CONTENT_END -->`
  )
  if (updated === html && !html.includes('SEO_CONTENT_START')) {
    console.warn('[generate-seo] public/index.html has no SEO_CONTENT markers - skipping homepage content injection.')
    return
  }
  fs.writeFileSync(indexPath, updated)
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

function renderAboutPage() {
  const bodyHtml = `
<nav class="seo-breadcrumb"><a href="/">Home</a> / About</nav>
<h1>About Passport &amp; Visa Photo Maker</h1>
<p>Passport &amp; Visa Photo Maker is a free, open-source tool for creating passport and visa photos that meet a country's exact size, background, and DPI requirements - entirely in your browser.</p>
<h2>Why it works this way</h2>
<p>A passport photo means uploading a picture of your face to something. Most tools do that by sending it to a server. This one doesn't: cropping, background removal, and face alignment all run locally using in-browser AI models (ONNX Runtime Web and MediaPipe). The only network requests they make are to download the model files themselves - never your photo. See the <a href="/privacy-policy.html">Privacy Policy</a> for the full detail, and the <a href="/methodology.html">Methodology</a> page for how requirement data is sourced.</p>
<h2>Open source</h2>
<p>The code is public on <a href="https://github.com/georgeputhean/passport-photo-maker" target="_blank" rel="noreferrer">GitHub</a>, so the "processed locally, never uploaded" claim above is something you can verify yourself, not just take on faith.</p>
<h2>What it isn't</h2>
<p>This is not a government service and isn't affiliated with any passport or visa issuing authority. It doesn't guarantee a photo will be accepted - requirements vary by country and change over time, so always confirm against the official source linked on each <a href="/photos/">country's page</a> before submitting.</p>
<a class="seo-cta" href="/">Open the photo editor &rarr;</a>
`
  return renderLayout({
    title: 'About - Passport & Visa Photo Maker',
    description: 'A free, open-source passport and visa photo tool that processes your photo entirely in your browser - it is never uploaded to a server.',
    canonicalPath: '/about.html',
    ldJson: [],
    bodyHtml,
  })
}

function renderContactPage() {
  const bodyHtml = `
<nav class="seo-breadcrumb"><a href="/">Home</a> / Contact</nav>
<h1>Contact</h1>
<p>Found a bug, an incorrect requirement, or have a question? Open an issue on GitHub and it'll be seen:</p>
<a class="seo-cta" href="https://github.com/georgeputhean/passport-photo-maker/issues" target="_blank" rel="noreferrer">Open an issue on GitHub &rarr;</a>
<p class="seo-source-note">This is the same channel used for bug reports, feature requests, and requirement corrections - see the <a href="/methodology.html">Methodology</a> page for how country requirements are sourced.</p>
`
  return renderLayout({
    title: 'Contact - Passport & Visa Photo Maker',
    description: 'How to report a bug, an incorrect requirement, or ask a question about Passport & Visa Photo Maker.',
    canonicalPath: '/contact.html',
    ldJson: [],
    bodyHtml,
  })
}

function renderMethodologyPage(entries) {
  const sourceRows = entries
    .filter((e) => e.content.sourceUrl)
    .map((e) => `    <tr><th>${escapeHtml(e.content.h1)}</th><td><a target="_blank" rel="noreferrer" href="${e.content.sourceUrl}">${escapeHtml(e.content.sourceLabel)}</a></td></tr>`)
    .join('\n')

  const bodyHtml = `
<nav class="seo-breadcrumb"><a href="/">Home</a> / Methodology</nav>
<h1>Methodology: how requirements are sourced</h1>
<p>Every country page on this site links directly to the government or consular source its size, background, and DPI figures come from - listed below in one place.</p>
<h2>Official sources by country/document</h2>
<table class="seo-spec">
  <tbody>
${sourceRows}
  </tbody>
</table>
<h2>What we don't do</h2>
<p>We don't claim continuous, dated verification against every source - requirements can change without notice, and a page that says "last verified" without an actual repeat check would be more misleading than useful. Instead, every country page links its official source directly so you can check the current wording yourself before submitting a photo.</p>
<h2>Corrections</h2>
<p>If a requirement here is out of date or wrong, please <a href="/contact.html">report it</a> - corrections are the main way this data stays accurate.</p>
`
  return renderLayout({
    title: 'Methodology - Passport & Visa Photo Maker',
    description: 'How passport and visa photo requirements on this site are sourced, with a direct link to the official government source for every country and document.',
    canonicalPath: '/methodology.html',
    ldJson: [],
    bodyHtml,
  })
}

function renderLlmsTxt(entries) {
  const lines = [
    '# Passport & Visa Photo Maker',
    '',
    '> Free, open-source tool that creates passport and visa photos meeting exact government size/background/DPI requirements, processed entirely in-browser (photos are never uploaded).',
    '',
    '## Main',
    `- [Photo editor](${SITE_URL}/): upload a photo, pick a country, crop/remove background, export at the correct size.`,
    `- [All countries](${SITE_URL}/photos/): index of every supported country and document type.`,
    `- [About](${SITE_URL}/about.html): what this tool is and how the privacy architecture works.`,
    `- [Methodology](${SITE_URL}/methodology.html): official source for every country's requirements.`,
    `- [Privacy Policy](${SITE_URL}/privacy-policy.html)`,
    '',
    '## Country and document requirements',
    ...entries.map((e) => `- [${e.content.h1}](${SITE_URL}/photos/${e.content.slug}.html)`),
    '',
  ]
  return lines.join('\n')
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
<h2>Affiliate links</h2>
<p>Some country requirement pages link to third-party print services (for example, retail photo counters). These may be affiliate links, meaning this site can earn a commission if you make a purchase after clicking through, at no extra cost to you. Affiliate links are labeled and never affect which requirements or recommendations are shown.</p>
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
    `${SITE_URL}/`,
    `${SITE_URL}/photos/`,
    ...entries.map((e) => `${SITE_URL}/photos/${e.content.slug}.html`),
    `${SITE_URL}/about.html`,
    `${SITE_URL}/contact.html`,
    `${SITE_URL}/methodology.html`,
    `${SITE_URL}/privacy-policy.html`,
  ]

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((loc) => `  <url><loc>${loc}</loc><lastmod>${BUILD_DATE}</lastmod></url>`).join('\n')}
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

async function main() {
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
  fs.mkdirSync(OG_DIR, { recursive: true })

  entries.forEach(({ template, content }) => {
    fs.writeFileSync(path.join(PHOTOS_DIR, `${content.slug}.html`), renderPhotoPage(template, content, entries))
  })

  for (const { template, content } of entries) {
    await generateOgImage(content, deriveSpec(template))
  }

  fs.writeFileSync(path.join(PHOTOS_DIR, 'index.html'), renderIndexPage(entries))
  fs.writeFileSync(path.join(PUBLIC_DIR, 'privacy-policy.html'), renderPrivacyPolicyPage())
  fs.writeFileSync(path.join(PUBLIC_DIR, 'about.html'), renderAboutPage())
  fs.writeFileSync(path.join(PUBLIC_DIR, 'contact.html'), renderContactPage())
  fs.writeFileSync(path.join(PUBLIC_DIR, 'methodology.html'), renderMethodologyPage(entries))
  fs.writeFileSync(path.join(PUBLIC_DIR, 'llms.txt'), renderLlmsTxt(entries))
  fs.writeFileSync(path.join(PUBLIC_DIR, 'sitemap.xml'), renderSitemap(entries))
  updateIndexHtml(entries)
  updateRobotsTxt()

  console.log(`[generate-seo] Generated ${entries.length} landing pages + OG images + index + sitemap + about/contact/methodology + llms.txt (SITE_URL=${SITE_URL}).`)
}

main().catch((err) => {
  console.error('[generate-seo] Failed:', err)
  process.exit(1)
})
