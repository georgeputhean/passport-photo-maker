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
const GUIDES_DIR = path.join(PUBLIC_DIR, 'guides')
const OG_DIR = path.join(PUBLIC_DIR, 'og')
const DIAGRAMS_DIR = path.join(PUBLIC_DIR, 'diagrams')
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

// Short background-color labels for the size-chart page, one line per
// template title - not new research, just a terser restatement of what each
// template's own seoContent.json intro paragraph already says.
const BACKGROUND_LABELS = {
  'US Passport/Visa Photo': 'White or off-white',
  'UK Passport Photo': 'Light-colored (cream/grey)',
  'Canada Passport Photo': 'White',
  'Canada Visa Photo': 'White or light-colored',
  'Indian Passport Photo': 'White',
  'Chinese Passport/Visa Photo': 'Light-colored (white/blue)',
  'Chinese Travel Document Photo': 'Light-colored',
  'Japan Passport/Visa Photo': 'White or light-colored',
  'Malaysia Passport Photo': 'White',
  'Mexico TN Visa Photo': 'White',
  'Spain Passport Photo': 'Light-colored',
  'Australia Passport/Visa Photo': 'White',
  'Germany Passport/Visa Photo': 'Light-colored (grey)',
  'Netherlands Passport Photo': 'White, light grey, or light blue',
  'South Korea Passport Photo': 'White',
  'Singapore Passport Photo': 'White',
  'Switzerland Passport Photo': 'Light, neutral, uniform (no white specified)',
  'Vietnam Passport Photo': 'White',
  'France Passport Photo': 'Light grey or light blue (white prohibited)',
  'OCI Card Photo': 'Plain light color (not white)',
}

// Vanilla JS click-to-sort, no dependency - toggles ascending/descending on
// the clicked column, comparing the numeric data-sort-value when present
// (so "35 x 45 mm" sorts as 35, not lexicographically) and falling back to
// the cell's text otherwise.
const SORTABLE_TABLE_SCRIPT = `
<script>
(function () {
  var table = document.getElementById('size-chart-table');
  if (!table) return;
  var headers = table.querySelectorAll('thead th[data-sort-key]');
  var tbody = table.querySelector('tbody');
  headers.forEach(function (th, colIndex) {
    th.style.cursor = 'pointer';
    th.addEventListener('click', function () {
      var ascending = th.getAttribute('data-sort-dir') !== 'asc';
      headers.forEach(function (h) { h.removeAttribute('data-sort-dir') });
      th.setAttribute('data-sort-dir', ascending ? 'asc' : 'desc');
      var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr'));
      rows.sort(function (a, b) {
        var cellA = a.children[colIndex];
        var cellB = b.children[colIndex];
        var valA = cellA.getAttribute('data-sort-value');
        var valB = cellB.getAttribute('data-sort-value');
        var cmp = (valA !== null && valB !== null)
          ? (parseFloat(valA) - parseFloat(valB))
          : cellA.textContent.localeCompare(cellB.textContent);
        return ascending ? cmp : -cmp;
      });
      rows.forEach(function (row) { tbody.appendChild(row) });
    });
  });
})();
</script>`

function renderSizeChartPage(entries) {
  const rows = entries.map(({ template, content }) => {
    const spec = deriveSpec(template)
    const background = BACKGROUND_LABELS[template.title] || 'See page'
    return `    <tr>
      <td><a href="/photos/${content.slug}.html">${escapeHtml(content.h1.replace(' Size and Requirements', ''))}</a></td>
      <td data-sort-value="${spec.widthMm}">${spec.widthMm} &times; ${spec.heightMm} mm</td>
      <td data-sort-value="${spec.widthMm}">${spec.widthIn}" &times; ${spec.heightIn}"</td>
      <td data-sort-value="${spec.dpi}">${spec.dpi}</td>
      <td>${escapeHtml(background)}</td>
      <td data-sort-value="${spec.maxSizeKb}">${spec.maxSizeKb} KB</td>
    </tr>`
  }).join('\n')

  const bodyHtml = `
<nav class="seo-breadcrumb"><a href="/">Home</a> / Passport photo size chart</nav>
<h1>Passport Photo Size Chart: Every Country Compared</h1>
<p>Every size, resolution, and background requirement this tool supports, in one sortable table. Click a column header to sort.</p>
<div style="overflow-x: auto;">
<table class="seo-spec" id="size-chart-table">
  <thead>
    <tr>
      <th data-sort-key="doc">Document</th>
      <th data-sort-key="mm">Size (mm)</th>
      <th data-sort-key="in">Size (in)</th>
      <th data-sort-key="dpi">DPI</th>
      <th data-sort-key="bg">Background</th>
      <th data-sort-key="kb">Max file size</th>
    </tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>
</div>
<p class="seo-source-note">Sizes, DPI, and file-size limits are read directly from this tool's own template data - the same values used when you make a photo. Background colors are a short summary; see each document's own page for the full requirement and official source.</p>
${SORTABLE_TABLE_SCRIPT}
${renderAdSlot('incontent')}
<a class="seo-cta" href="/">Make a photo now &rarr;</a>
${renderAdSlot('footer')}
`
  return renderLayout({
    title: 'Passport Photo Size Chart: Every Country Compared - Passport & Visa Photo Maker',
    description: 'Sortable table of passport and visa photo size, DPI, background color, and file-size requirements for every country and document this tool supports.',
    canonicalPath: '/guides/passport-photo-size-chart.html',
    ldJson: [
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_URL}/` },
          { '@type': 'ListItem', position: 2, name: 'Passport photo size chart', item: `${SITE_URL}/guides/passport-photo-size-chart.html` },
        ],
      },
      {
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: 'Passport Photo Size Chart: Every Country Compared',
        description: 'Sortable table of passport and visa photo size, DPI, background color, and file-size requirements for every country and document this tool supports.',
        dateModified: BUILD_DATE,
      },
    ],
    bodyHtml,
  })
}

// A single-size page (e.g. "2x2 passport photo") is a narrower cut of the same
// data as the size chart, filtered to one exact mm size - genuinely useful for
// a size-specific search rather than a duplicate of the chart, since it also
// adds pixel-equivalent figures and an FAQ block the chart doesn't have.
function renderSizeGroupPage(entries, { slug, dir, widthMm, heightMm, title, metaTitle, metaDescription, intro, faqs }) {
  const matches = entries.filter(({ template }) => {
    const spec = deriveSpec(template)
    return Math.round(spec.widthMm) === widthMm && Math.round(spec.heightMm) === heightMm
  })

  const rows = matches.map(({ template, content }) => {
    const spec = deriveSpec(template)
    const background = BACKGROUND_LABELS[template.title] || 'See page'
    return `    <tr>
      <td><a href="/photos/${content.slug}.html">${escapeHtml(content.h1.replace(' Size and Requirements', ''))}</a></td>
      <td data-sort-value="${spec.dpi}">${spec.dpi}</td>
      <td>${escapeHtml(background)}</td>
      <td data-sort-value="${spec.maxSizeKb}">${spec.maxSizeKb} KB</td>
    </tr>`
  }).join('\n')

  const pixelRows = [300, 400, 600].map((dpi) => {
    const w = Math.trunc((widthMm / MM_PER_INCH) * dpi)
    const h = Math.trunc((heightMm / MM_PER_INCH) * dpi)
    return `    <tr><td data-sort-value="${dpi}">${dpi} DPI</td><td>${w} &times; ${h} px</td></tr>`
  }).join('\n')

  const countryLinks = matches.length
    ? `<ul class="seo-checklist">${matches.map(({ content }) => `<li><a href="/photos/${content.slug}.html">${escapeHtml(content.h1.replace(' Size and Requirements', ''))}</a></li>`).join('')}</ul>`
    : `<p>None of the documents this tool currently supports use exactly this size - see the <a href="/guides/passport-photo-size-chart.html">full size chart</a> for what's available.</p>`

  const bodyHtml = `
<nav class="seo-breadcrumb"><a href="/">Home</a> / ${escapeHtml(title)}</nav>
<h1>${escapeHtml(title)}</h1>
<p><strong>${intro}</strong></p>
<h2>Which documents use this size</h2>
${countryLinks}
${matches.length ? `<div style="overflow-x: auto;">
<table class="seo-spec" id="${slug}-table">
  <thead>
    <tr>
      <th data-sort-key="doc">Document</th>
      <th data-sort-key="dpi">DPI</th>
      <th data-sort-key="bg">Background</th>
      <th data-sort-key="kb">Max file size</th>
    </tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>
</div>
${SORTABLE_TABLE_SCRIPT}` : ''}
<h2>${widthMm}&times;${heightMm}mm in pixels</h2>
<p>The pixel size depends on the DPI (resolution) a specific document requires - here's ${widthMm}&times;${heightMm}mm at a few common resolutions:</p>
<table class="seo-spec">
  <thead><tr><th>Resolution</th><th>Pixel size</th></tr></thead>
  <tbody>
${pixelRows}
  </tbody>
</table>
<p class="seo-source-note">DPI and file-size limits are read directly from this tool's own template data - the same values used when you make a photo.</p>
${renderAdSlot('incontent')}
<a class="seo-cta" href="/">Make a ${widthMm}&times;${heightMm}mm photo now &rarr;</a>
<p>See the <a href="/guides/passport-photo-size-chart.html">full size chart</a> for every country and document this tool supports.</p>
<h2>FAQ</h2>
${faqs.map((f) => `<div class="seo-faq-item"><h3>${escapeHtml(f.q)}</h3><p>${escapeHtml(f.a)}</p></div>`).join('\n')}
${renderAdSlot('footer')}
`
  return renderLayout({
    title: metaTitle,
    description: metaDescription,
    canonicalPath: `/${dir}/${slug}.html`,
    ldJson: [{
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
    }],
    bodyHtml,
  })
}

const SIZE_GROUP_PAGES = [
  {
    slug: '2x2-passport-photo',
    dir: 'sizes',
    widthMm: 51,
    heightMm: 51,
    title: '2x2 Passport Photo Size',
    metaTitle: '2x2 Passport Photo Size in mm, Inches, and Pixels - Passport & Visa Photo Maker',
    metaDescription: 'A 2x2 in. passport photo is 51x51mm, or 600x600px at 300 DPI. Which documents use this size, and how to make one free.',
    intro: 'A "2x2 passport photo" is 2 by 2 inches - 51 by 51mm - the standard size for a U.S. passport or visa photo. At 300 DPI, that\'s 600&times;600 pixels.',
    faqs: [
      { q: 'Is 2x2 inches the same as 51x51mm?', a: '2 inches is 50.8mm, rounded to 51mm - the two figures describe the same size, just in different units.' },
      { q: 'What DPI should a 2x2 passport photo be?', a: '300 DPI is the standard requirement for a U.S. passport photo, giving a 600x600 pixel image at this size.' },
      { q: 'Is a 2x2 photo the same as a square online-upload photo?', a: 'Not necessarily - the printed 2x2in photo and the digital upload for online renewal are specified differently. See our <a href="/guides/online-passport-renewal-photo.html">online renewal photo guide</a> for the digital-upload spec.' },
    ],
  },
  {
    slug: '35x45-passport-photo',
    dir: 'sizes',
    widthMm: 35,
    heightMm: 45,
    title: '35x45mm Passport Photo Size',
    metaTitle: '35x45mm Passport Photo Size: Countries & Pixel Equivalents - Passport & Visa Photo Maker',
    metaDescription: '35x45mm is the passport and visa photo size used across the UK, Schengen area, India, and more. Pixel sizes at common DPIs and which documents use it.',
    intro: '35 by 45mm is one of the most widely used passport and visa photo sizes worldwide, shared by the UK, several Schengen-area countries, India, and others - each still sets its own DPI and background requirement, so check the specific document\'s page.',
    faqs: [
      { q: 'Why do so many countries use the same 35x45mm size?', a: 'It broadly follows ICAO-influenced sizing conventions used across many national passport and visa systems, though each country still publishes and can change its own exact requirement.' },
      { q: 'Is the DPI the same for every 35x45mm document?', a: 'No - DPI (and therefore the exact pixel output) varies by document even at the same physical size. Check the table above or the specific document\'s page.' },
      { q: 'My country isn\'t listed here - what size does it use?', a: 'See the <a href="/guides/passport-photo-size-chart.html">full size chart</a> for every country and document this tool currently supports.' },
    ],
  },
]

// Pricing researched via web search, most recently 1 August 2026, not scraped
// live at build time - it drifts, so re-check periodically. Each entry says
// how it was checked: 'primary' means we fetched the operator's own page
// directly; 'secondary' means the operator's own pricing page has blocked
// every automated fetch attempt so far, so the figure is instead cross-checked
// against several independent, current pricing/comparison sources (see
// sourceCount) and flagged as such on the page, rather than silently treated
// as equivalent to a primary-confirmed figure.
const RETAILERS = [
  {
    slug: 'walgreens-passport-photo',
    name: 'Walgreens',
    price: '$16.99',
    priceConfidence: 'secondary',
    priceCheckedDate: '1 August 2026',
    sourceCount: 3,
    details: 'for two 2x2 in. printed photos, with a free digital copy emailed to you.',
    process: 'Walk in to the photo counter at any Walgreens with a photo department - no appointment needed. Photos are typically ready within a few minutes.',
    sourceUrl: 'https://photo.walgreens.com/store/passport-photos',
    sourceLabel: 'Walgreens Photo',
    affiliate: { name: 'Walgreens', envVar: 'REACT_APP_AFFILIATE_WALGREENS_URL', fallbackUrl: 'https://www.walgreens.com/topic/passport-photos.jsp' },
  },
  {
    slug: 'cvs-passport-photo',
    name: 'CVS',
    price: '$16.99-$17.99',
    priceConfidence: 'secondary',
    priceCheckedDate: '1 August 2026',
    sourceCount: 6,
    details: 'for two 2x2 in. printed photos taken at the photo counter; sources disagree on the exact figure, roughly evenly split between $16.99 and $17.99. A digital copy is a separate paid add-on (around $3.99) at some locations.',
    process: 'Walk in to the photo counter at a CVS with a photo department - no appointment needed in most cases.',
    sourceUrl: 'https://www.cvs.com/content/passport-photos',
    sourceLabel: 'CVS Photo',
    affiliate: { name: 'CVS', envVar: 'REACT_APP_AFFILIATE_CVS_URL', fallbackUrl: 'https://www.cvs.com/content/passport-photos' },
  },
  {
    slug: 'walmart-passport-photo',
    name: 'Walmart',
    price: '$7.64',
    priceConfidence: 'secondary',
    priceCheckedDate: '1 August 2026',
    sourceCount: 5,
    details: 'for two 2x2 in. printed photos at locations with a Photo Center - the cheapest of the major retail chains. No digital copy is included with the standard in-store service.',
    process: 'Check that your local Walmart has a Photo Center before going (not all do), then walk in - no appointment needed.',
    sourceUrl: 'https://www.walmart.com/cp/photo-center-passport-photos/1078557',
    sourceLabel: 'Walmart Photo Center',
    affiliate: { name: 'Walmart', envVar: 'REACT_APP_AFFILIATE_WALMART_URL', fallbackUrl: 'https://www.walmart.com/cp/photo-center-passport-photos/1078557' },
  },
  {
    slug: 'usps-passport-photo',
    name: 'USPS',
    price: '$15.00',
    priceConfidence: 'primary',
    details: 'as a flat Post Office acceptance fee, per USPS\'s own site. Not all post offices offer photo service - many do, but availability and whether you need an appointment vary by location.',
    process: 'Use the USPS online appointment scheduler or call ahead to confirm your local post office offers passport photos before visiting.',
    sourceUrl: 'https://www.usps.com/international/passports.htm',
    sourceLabel: 'USPS',
    affiliate: null,
  },
]

// GUIDE_PAGES is the sitemap/index/llms.txt manifest for every guide-like page,
// regardless of which directory it's written to (see each entry's `dir`, default
// 'guides'). Bespoke pages are listed by hand; INFO_GUIDES-driven pages are derived
// below so slug/title/dir can't drift out of sync between the two arrays.
const GUIDE_PAGES = [
  ...RETAILERS.map((r) => ({ slug: r.slug, title: `${r.name} Passport Photo Price` })),
  { slug: 'passport-photo-cost', title: 'Passport Photo Cost: Every Option Compared' },
  { slug: 'print-passport-photos-at-home', title: 'How to Print Passport Photos at Home' },
  { slug: 'ai-edited-passport-photos-2026', title: 'Can You Use AI to Edit a Passport Photo? (2026 Rules)' },
  { slug: 'passport-photo-size-chart', title: 'Passport Photo Size Chart: Every Country Compared' },
  { slug: 'baby-newborn-passport-photo', title: 'Baby and Newborn Passport Photo Guide' },
  { slug: 'take-passport-photo-with-phone', title: 'How to Take a Passport Photo with Your Phone' },
  { slug: 'passport-photo-background-color', title: 'What Background Color Do Passport Photos Need?' },
  { slug: 'passport-photo-rejected', title: 'Passport Photo Rejected? Common Reasons and How to Fix It' },
  { slug: 'best-free-passport-photo-makers', title: 'Best Free Passport Photo Makers, Compared', dir: 'compare' },
]

function affiliateUrl(affiliate) {
  return process.env[affiliate.envVar] || affiliate.fallbackUrl
}

function renderRetailerGuide(retailer) {
  const confidenceNote = retailer.priceConfidence === 'primary'
    ? `Checked directly against ${escapeHtml(retailer.sourceLabel)}'s own site, ${BUILD_DATE}.`
    : `${escapeHtml(retailer.sourceLabel)}'s own pricing page has blocked automated fetches every time we've checked, most recently ${escapeHtml(retailer.priceCheckedDate || BUILD_DATE)}, so this figure isn't confirmed against the primary source directly - it's cross-checked against ${escapeHtml(String(retailer.sourceCount || 'several'))} independent, current pricing/comparison sites that all agree on this number as of that date. Prices vary by location and change - call ahead or confirm in-store.`

  const visitLink = retailer.affiliate
    ? `<p><a target="_blank" rel="sponsored noopener" href="${escapeHtml(affiliateUrl(retailer.affiliate))}">Visit ${escapeHtml(retailer.name)}'s passport photo page &rarr;</a> <span class="seo-source-note">(may be a sponsored link - see disclosure below)</span></p>`
    : `<p><a target="_blank" rel="noreferrer" href="${escapeHtml(retailer.sourceUrl)}">Find a participating post office &rarr;</a></p>`

  const isPostOffice = !retailer.affiliate
  const counterNoun = isPostOffice ? 'the counter' : 'the photo counter'

  const faqs = [
    {
      q: `Does ${retailer.name} guarantee the photo will be accepted?`,
      a: isPostOffice
        ? `USPS staff are trained on the current State Department spec and will generally catch an obviously non-compliant photo before you leave, but final acceptance is always up to the passport agency reviewing your application - not the office that took the photo.`
        : `No - staff are trained on the standard size/background spec and will generally catch an obviously bad shot, but final acceptance is up to the agency reviewing your application, not the store. A rejected application over a subtle issue (a slight shadow, a barely-off expression) is possible even from a paid, in-person photo.`,
    },
    {
      q: `Can I bring my own printed photo to ${retailer.name} instead of using the counter service?`,
      a: isPostOffice
        ? `Yes - USPS accepts a compliant photo you bring yourself; the fee above is specifically for having USPS take the photo for you. Bringing your own (for example, printed from this tool's export) skips that fee entirely.`
        : `Some locations will print a photo you've already made and cropped correctly (using this tool, for example) rather than charging the full in-person photo-taking fee - ask at the counter, since this varies by store and isn't guaranteed.`,
    },
    {
      q: `What should I bring?`,
      a: `A form of ID is often requested, plus payment for the fee. If you already have a compliant digital photo (made here, for instance), bring it on your phone or a USB drive in case the location offers a print-only service.`,
    },
  ]

  const bodyHtml = `
<nav class="seo-breadcrumb"><a href="/">Home</a> / <a href="/guides/passport-photo-cost.html">Passport photo cost</a> / ${escapeHtml(retailer.name)}</nav>
<h1>${escapeHtml(retailer.name)} Passport Photo: Price and How It Works</h1>
<p><strong>${escapeHtml(retailer.price)}</strong> ${escapeHtml(retailer.details)}</p>
<p class="seo-source-note">${confidenceNote}</p>
<h2>How it works</h2>
<p>${escapeHtml(retailer.process)}</p>
${visitLink}
<h2>What to expect at ${escapeHtml(counterNoun)}</h2>
<ol class="seo-steps">
  <li><strong>Staff position you against a plain backdrop</strong> (usually a portable screen or wall) and take the photo with a dedicated camera, not a phone.</li>
  <li><strong>They review it on-screen with you</strong> - a clearly bad shot (eyes closed, obvious shadow) is often retaken on the spot, but subtler compliance issues aren't always caught.</li>
  <li><strong>Photos print in a few minutes to about an hour</strong>, depending on the location and how busy the photo counter is.</li>
  <li><strong>You leave with physical prints</strong> (and a digital copy too, if that's included - see the price breakdown above) - there's typically no separate cropping or sizing step since the in-store system is set up for the standard size already.</li>
</ol>
<h2>Get it right the first time</h2>
<p>A retaken photo still costs the same trip, so it's worth arriving ready:</p>
<ul class="seo-checklist">
  <li>Wear your everyday glasses only if you're used to them - a growing number of countries now discourage or ban glasses entirely in the photo. See our <a href="/guides/passport-photo-glasses.html">glasses guide</a>.</li>
  <li>Skip anything white or very light-colored that blends into a light background.</li>
  <li>Practice a neutral, mouth-closed expression beforehand - see our <a href="/guides/can-you-smile-in-a-passport-photo.html">expression guide</a> for what "neutral" actually means.</li>
  <li>If you're bringing a child, see our <a href="/guides/baby-newborn-passport-photo.html">baby and newborn photo guide</a> first - the rules differ from an adult's.</li>
</ul>
<h2>A free alternative</h2>
<p>You can also make a compliant photo here for free and print it yourself: our editor exports a 4x6 sheet packed with as many copies as fit, with dotted cut guides, ready for a standard photo-paper print - typically well under a dollar at a drugstore print kiosk or your own printer.</p>
<a class="seo-cta" href="/">Make a free passport photo &rarr;</a>
<p><a href="/guides/print-passport-photos-at-home.html">Full guide: how to print passport photos at home &rarr;</a></p>
<h2>Compare all options</h2>
<p>See how ${escapeHtml(retailer.name)} stacks up against the other retailers and the DIY option on our <a href="/guides/passport-photo-cost.html">passport photo cost comparison</a> page.</p>
${renderAdSlot('incontent')}
<h2>FAQ</h2>
${faqs.map((f) => `<div class="seo-faq-item"><h3>${escapeHtml(f.q)}</h3><p>${escapeHtml(f.a)}</p></div>`).join('\n')}
${renderAffiliateSection()}
${renderAdSlot('footer')}
`
  return renderLayout({
    title: `${retailer.name} Passport Photo Price 2026 - Passport & Visa Photo Maker`,
    description: `${retailer.name} passport photo price and how the process works, plus a free way to make and print a compliant photo yourself.`,
    canonicalPath: `/guides/${retailer.slug}.html`,
    ldJson: [
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_URL}/` },
          { '@type': 'ListItem', position: 2, name: 'Passport photo cost', item: `${SITE_URL}/guides/passport-photo-cost.html` },
          { '@type': 'ListItem', position: 3, name: `${retailer.name} Passport Photo`, item: `${SITE_URL}/guides/${retailer.slug}.html` },
        ],
      },
      {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
      },
      {
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: `${retailer.name} Passport Photo: Price and How It Works`,
        description: `${retailer.name} passport photo price and how the process works, plus a free way to make and print a compliant photo yourself.`,
        dateModified: BUILD_DATE,
      },
    ],
    bodyHtml,
  })
}

function renderCostComparisonPage() {
  const rows = RETAILERS.map((r) => `    <tr><th><a href="/guides/${r.slug}.html">${escapeHtml(r.name)}</a></th><td>${escapeHtml(r.price)}</td></tr>`).join('\n')
  const faqs = [
    { q: 'Which option is actually the cheapest?', a: 'Making your own photo here and printing a 4x6 sheet yourself - typically under $1 total, versus $7.64-$17.99 at a retail counter. Walmart is the cheapest paid retail option; CVS is typically the most expensive.' },
    { q: 'Is the cheapest option also the fastest?', a: 'Usually not - a retail counter hands you a finished, printed photo in minutes. The DIY route is nearly free but takes a few minutes of your own time to photograph, crop, and print (or find a kiosk).' },
    { q: 'Do any of these include a digital copy?', a: 'It varies and changes - Walgreens has historically included one free, CVS has charged extra for it, and Walmart\'s standard in-store service hasn\'t included one. Check the individual retailer page, and confirm at the counter since offers change.' },
    { q: 'Why is the price range so wide ($7.64 to $17.99) for what looks like the same service?', a: 'These aren\'t regulated fees - each retailer sets its own price for the photo-taking-and-printing service, and it isn\'t obviously correlated with quality. The photo itself has the same size/background spec everywhere; you\'re mostly paying for someone else to operate the camera and printer.' },
  ]
  const bodyHtml = `
<nav class="seo-breadcrumb"><a href="/">Home</a> / Passport photo cost</nav>
<h1>Passport Photo Cost: Every Option Compared (2026)</h1>
<p><strong>A passport photo costs anywhere from about $0.20 (print your own at Walmart) to about $18 (CVS) depending on where you get it.</strong> Here's what the major U.S. options charge, and why the free alternative works just as well.</p>
<table class="seo-spec">
  <tbody>
${rows}
    <tr><th>This tool + your own printer</th><td>Free (editor) - typically under $1 to print</td></tr>
  </tbody>
</table>
<p class="seo-source-note">Prices researched via web search, most recently ${BUILD_DATE}, and cross-checked against multiple current sources where the retailer's own pricing page blocked a direct check - see each retailer's own page for the exact sourcing note. Retail prices vary by location and change over time; confirm before you go.</p>
<h2>What you're actually paying for</h2>
<p>Every option here produces the same underlying thing: a photo that meets a government size/background/quality spec. The retail options charge for the service of taking and printing it - a person operating a camera, a printer, and (in principle) a compliance check. None of them are more "official" than a compliant photo you make yourself; the passport agency doesn't care who pressed the shutter, only whether the result matches the spec.</p>
<h2>Why the DIY option is so much cheaper</h2>
<p>Retail photo counters charge for a service: taking the photo, checking it against the spec, and printing it in-store. If you take your own photo, this tool checks the size, background, and framing against the requirement automatically and exports a 4x6 print sheet with multiple copies and cut guides - so all you're paying for is the print itself, typically well under a dollar at a drugstore print kiosk or your own printer.</p>
<a class="seo-cta" href="/">Make a free passport photo &rarr;</a>
<h2>Which option makes sense for you</h2>
<ul class="seo-checklist">
  <li><strong>Want it done for you, don't mind the cost:</strong> any of the retail counters below - Walmart is the cheapest of the paid options.</li>
  <li><strong>Want to save money and don't mind five extra minutes:</strong> make it here for free, then print at any drugstore kiosk (typically $0.20-$0.50 for a 4x6) or your own printer.</li>
  <li><strong>Need it for an online application (no printing at all):</strong> export the single photo file here instead of the print sheet - see our <a href="/guides/online-passport-renewal-photo.html">online renewal photo guide</a> for the different spec that applies there.</li>
  <li><strong>Not confident about the size/background rules:</strong> use this tool's built-in "Check Photo" feature before you print or submit anything, regardless of where the photo came from.</li>
</ul>
<h2>Individual retailer guides</h2>
<ul class="seo-index-list">
${RETAILERS.map((r) => `  <li><a href="/guides/${r.slug}.html">${escapeHtml(r.name)} passport photo</a></li>`).join('\n')}
  <li><a href="/guides/print-passport-photos-at-home.html">How to print passport photos at home</a></li>
</ul>
${renderAdSlot('incontent')}
<h2>FAQ</h2>
${faqs.map((f) => `<div class="seo-faq-item"><h3>${escapeHtml(f.q)}</h3><p>${escapeHtml(f.a)}</p></div>`).join('\n')}
${renderAffiliateSection()}
${renderAdSlot('footer')}
`
  return renderLayout({
    title: 'Passport Photo Cost: Every Option Compared (2026) - Passport & Visa Photo Maker',
    description: 'What Walgreens, CVS, Walmart, and USPS charge for passport photos in 2026, compared to making one free and printing it yourself.',
    canonicalPath: '/guides/passport-photo-cost.html',
    ldJson: [
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_URL}/` },
          { '@type': 'ListItem', position: 2, name: 'Passport photo cost', item: `${SITE_URL}/guides/passport-photo-cost.html` },
        ],
      },
      {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
      },
      {
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: 'Passport Photo Cost: Every Option Compared (2026)',
        description: 'What Walgreens, CVS, Walmart, and USPS charge for passport photos in 2026, compared to making one free and printing it yourself.',
        dateModified: BUILD_DATE,
      },
    ],
    bodyHtml,
  })
}

function renderPrintAtHomeGuidePage() {
  const faqs = [
    { q: 'Will a home-printed photo be accepted?', a: 'Requirements are generally about the photo meeting the size/background/quality spec, not where it was printed - but always check the official source linked on your country\'s page, since a small number of application types require professional printing specifically.' },
    { q: 'What paper size do I need?', a: 'Standard 4x6 in. photo paper is enough for most passport photo sizes printed multiple-up with this tool\'s print-sheet export; check your printer or kiosk supports 4x6 prints.' },
    { q: 'Can I use an inkjet printer?', a: 'Yes, as long as it can print at photo quality on photo paper - results vary more by paper and print-quality setting than by printer brand.' },
  ]
  const bodyHtml = `
<nav class="seo-breadcrumb"><a href="/">Home</a> / Print passport photos at home</nav>
<h1>How to Print Passport Photos at Home</h1>
<p>You don't need a photo counter to get a print-ready passport photo - a home printer or a drugstore print kiosk can produce one that meets spec, for a fraction of the in-store price. See the full <a href="/guides/passport-photo-cost.html">cost comparison</a> for how much that saves.</p>
<h2>1. Make the photo</h2>
<p>Pick your country/document in the <a href="/">editor</a>, upload a photo, and export. This handles the cropping, sizing, and DPI automatically - the part most home attempts get wrong.</p>
<h2>2. Export the 4x6 print sheet, not just the single photo</h2>
<p>Alongside the single photo file, the editor can export a 4x6 sheet packed with as many copies as fit at the correct size, with dotted cut guides between them - one print gets you multiple copies instead of paying per photo.</p>
<h2>3. Print settings that actually matter</h2>
<ul class="seo-checklist">
  <li>Use actual photo paper (matte or glossy), not plain printer paper - most requirements expect photo-quality stock.</li>
  <li>Print at "actual size" or "100%" - never "fit to page" or "shrink to fit", which rescales the photo and throws off the exact dimensions.</li>
  <li>If printing yourself, set the printer to its highest quality/photo mode; the file is already generated at the correct DPI for the document, but a low print-quality setting can still soften fine detail.</li>
  <li>A drugstore photo kiosk (Walgreens, CVS, Walmart, Costco, and similar all have them) will print a 4x6 you upload for well under a dollar - upload the sheet file exported above and print at 4x6, not a cropped/auto-enhanced setting.</li>
</ul>
<h2>4. Cut carefully</h2>
<p>Cut along the dotted guides with a straight edge or paper cutter. A slightly uneven cut is a common, avoidable rejection reason - take your time.</p>
<a class="seo-cta" href="/">Make your photo now &rarr;</a>
${renderAdSlot('incontent')}
<h2>FAQ</h2>
${faqs.map((f) => `<div class="seo-faq-item"><h3>${escapeHtml(f.q)}</h3><p>${escapeHtml(f.a)}</p></div>`).join('\n')}
${renderAdSlot('footer')}
`
  return renderLayout({
    title: 'How to Print Passport Photos at Home - Passport & Visa Photo Maker',
    description: 'How to export and print a compliant passport photo yourself, with the right paper, print settings, and a 4x6 sheet with multiple copies and cut guides.',
    canonicalPath: '/guides/print-passport-photos-at-home.html',
    ldJson: [
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_URL}/` },
          { '@type': 'ListItem', position: 2, name: 'Print passport photos at home', item: `${SITE_URL}/guides/print-passport-photos-at-home.html` },
        ],
      },
      {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
      },
    ],
    bodyHtml,
  })
}

function renderAiEditingGuidePage() {
  const bodyHtml = `
<nav class="seo-breadcrumb"><a href="/">Home</a> / AI-edited passport photos in 2026</nav>
<h1>Can You Use AI to Edit a Passport Photo? (2026 Rules)</h1>
<p>For a US passport or visa: no. As of 2026, the U.S. State Department's guidance says not to change your photo using computer software, phone apps, filters, or artificial intelligence, and that submitted photos are checked for this - see the <a href="https://travel.state.gov/content/travel/en/passports/how-apply/photos.html" target="_blank" rel="noreferrer">official photo requirements page</a>.</p>
<h2>What counts as "editing"</h2>
<p>The rule draws a line between two different kinds of changes:</p>
<ul class="seo-checklist">
  <li><strong>Format changes (fine):</strong> cropping to the required size, resizing, correcting DPI, converting the file format.</li>
  <li><strong>Appearance changes (not accepted for a US application):</strong> replacing or editing the background, smoothing skin, changing eye color, removing blemishes, fixing red-eye, or any AI-generated or AI-retouched image.</li>
</ul>
<p>Multiple 2026 reports describe automated detection flagging altered photos before a human even reviews them, including background replacement specifically - see the sources at the bottom of this page. We haven't independently verified every detail of how the detection works, only that the underlying no-alteration policy is real and current.</p>
<h2>Why this exists</h2>
<p>The stated purpose is protecting the facial biometric matching used by border officials and identity verification systems - an altered background or smoothed/retouched face can interfere with that matching even if the photo looks fine to a person.</p>
<h2>What to do instead</h2>
<ul class="seo-checklist">
  <li>Retake the photo against a genuine plain white or off-white wall, rather than removing the background afterward.</li>
  <li>Use good, even lighting so you don't need to fix shadows in post-processing.</li>
  <li>Use this tool's <strong>Compliance Mode</strong> for the US template - it only crops and resizes, with no option to alter the background, so there's nothing to accidentally get flagged.</li>
  <li>If you've already used a background-removal tool (including this one's Edit Mode) for a US application, retake the photo rather than submitting the altered version.</li>
</ul>
<a class="seo-cta" href="/?template=US%20Passport%2FVisa%20Photo">Use Compliance Mode for a US photo &rarr;</a>
<h2>What about other countries?</h2>
<p>We've specifically confirmed the US policy above. We have not found a published ban on background removal for the other countries this tool supports, but policies are changing across the industry - check the official source on each <a href="/photos/">country's page</a> before using background removal for any government application, and default to caution if you're unsure.</p>
${renderAdSlot('incontent')}
<h2>FAQ</h2>
<div class="seo-faq-item"><h3>Is cropping considered "editing" too?</h3><p>No - cropping, resizing, and correcting DPI are format changes and are explicitly fine. The restriction is on changing what's actually in the photo (background, skin, features), not its dimensions.</p></div>
<div class="seo-faq-item"><h3>What if my photo was rejected and I don't know why?</h3><p>A rejected application doesn't always explain the exact reason. If you used any background removal, filter, or retouching app, that's now one of the most likely causes - retake against a plain wall and avoid editing tools entirely for the resubmission.</p></div>
<div class="seo-faq-item"><h3>Does this apply to visa photos too, or just passports?</h3><p>The State Department guidance covers passport photos; many visa photo requirements reference the same standard. Check the specific application's instructions.</p></div>
<p class="seo-source-note">Sources: <a href="https://travel.state.gov/content/travel/en/passports/how-apply/photos.html" target="_blank" rel="noreferrer">U.S. Department of State passport photo requirements</a> (official, primary source - fetching it directly returned an access-denied response for us, so this page's wording is corroborated via multiple independent 2026 news/guide sources rather than a live quote). Reported on by multiple outlets in 2026 covering the policy and rejection trend; this page summarizes rather than reproduces any single article. Always check the official page above, which supersedes anything summarized here.</p>
${renderAdSlot('footer')}
`
  return renderLayout({
    title: 'Can You Use AI to Edit a Passport Photo? 2026 Rules Explained',
    description: 'The U.S. State Department does not accept AI-edited or background-replaced passport photos as of 2026. What counts as editing, why it matters, and what to do instead.',
    canonicalPath: '/guides/ai-edited-passport-photos-2026.html',
    ldJson: [{
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: [
        { '@type': 'Question', name: 'Is cropping considered "editing" too?', acceptedAnswer: { '@type': 'Answer', text: 'No - cropping, resizing, and correcting DPI are format changes and are explicitly fine. The restriction is on changing what\'s actually in the photo (background, skin, features), not its dimensions.' } },
        { '@type': 'Question', name: 'What if my photo was rejected and I don\'t know why?', acceptedAnswer: { '@type': 'Answer', text: 'A rejected application doesn\'t always explain the exact reason. If you used any background removal, filter, or retouching app, that\'s now one of the most likely causes - retake against a plain wall and avoid editing tools entirely for the resubmission.' } },
        { '@type': 'Question', name: 'Does this apply to visa photos too, or just passports?', acceptedAnswer: { '@type': 'Answer', text: 'The State Department guidance covers passport photos; many visa photo requirements reference the same standard. Check the specific application\'s instructions.' } },
      ],
    }],
    bodyHtml,
  })
}

// Shared wrapper for short, direct-answer guide pages (glasses, head
// coverings, smiling, background color, lighting) - same shape each time:
// a one-paragraph answer up top, a few sections, an FAQ block.
function renderInfoGuidePage({ slug, title, dir, metaTitle, metaDescription, answer, sections, faqs }) {
  const bodyHtml = `
<nav class="seo-breadcrumb"><a href="/">Home</a> / ${escapeHtml(title)}</nav>
<h1>${escapeHtml(title)}</h1>
<p><strong>${escapeHtml(answer)}</strong></p>
${sections.map((s) => `<h2>${escapeHtml(s.heading)}</h2>\n${s.bodyHtml}`).join('\n')}
<a class="seo-cta" href="/">Make a compliant photo now &rarr;</a>
${renderAdSlot('incontent')}
<h2>FAQ</h2>
${faqs.map((f) => `<div class="seo-faq-item"><h3>${escapeHtml(f.q)}</h3><p>${escapeHtml(f.a)}</p></div>`).join('\n')}
${renderAdSlot('footer')}
`
  return renderLayout({
    title: metaTitle,
    description: metaDescription,
    canonicalPath: `/${dir || 'guides'}/${slug}.html`,
    ldJson: [{
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
    }],
    bodyHtml,
  })
}

const INFO_GUIDES = [
  {
    slug: 'passport-photo-glasses',
    title: 'Can You Wear Glasses in a Passport Photo?',
    metaTitle: 'Can You Wear Glasses in a Passport Photo? - Passport & Visa Photo Maker',
    metaDescription: 'Most countries now discourage or disallow glasses in passport photos due to glare and reflection. What to do instead, and the medical exceptions some countries allow.',
    answer: 'Increasingly, no. Most countries this tool supports now discourage or explicitly disallow glasses in passport and visa photos, because glare and lens reflection can interfere with facial-recognition matching. Check your specific country\'s page for the current rule before you shoot.',
    sections: [
      { heading: 'Why the rule exists', bodyHtml: '<p>Passport photos are increasingly matched against biometric facial-recognition systems at border control. Reflections, tinting, or frames covering the eyes can interfere with that matching, which is why glasses have gone from "usually fine" to "usually not accepted" across many countries in recent years.</p>' },
      { heading: 'What to do', bodyHtml: '<p>Take the photo without glasses. If you have a genuine medical reason you can\'t remove them (for example, right after eye surgery), check your specific country\'s official guidance - some allow a documented medical exception, typically requiring a note and glasses with no tint and no glare.</p>' },
    ],
    faqs: [
      { q: 'Will this tool tell me if I\'m wearing glasses?', a: 'The built-in "Check My Photo" compliance check includes a glasses heuristic, but it\'s explicitly labeled a low-confidence check in the results, not a guarantee - it can miss glasses or flag something that isn\'t glasses.' },
      { q: 'What if my glasses have no glare at all?', a: 'Some countries still don\'t accept glasses regardless of glare, since the frame itself can obscure part of the eye area used for matching - check the specific rule for your document.' },
      { q: 'Are contact lenses a problem?', a: 'No - the rule is about glasses/frames, not vision correction generally.' },
    ],
  },
  {
    slug: 'passport-photo-head-covering',
    title: 'Passport Photos with a Hijab, Turban, or Religious Head Covering',
    metaTitle: 'Passport Photo with a Head Covering: What\'s Allowed - Passport & Visa Photo Maker',
    metaDescription: 'Religious head coverings are generally permitted in passport photos as long as the full face is visible with no shadow. What\'s allowed and what to watch for.',
    answer: 'Yes, generally permitted. Most countries this tool supports allow a head covering worn daily for religious reasons, as long as your full face - from the bottom of your chin to the top of your forehead - is clearly visible, with no shadow cast on your face by the covering.',
    sections: [
      { heading: 'What\'s allowed', bodyHtml: '<p>A hijab, turban, or other religious head covering that doesn\'t obscure the face outline is typically fine. The requirement is about the face being fully visible for identification, not about the covering itself.</p>' },
      { heading: 'What to watch for', bodyHtml: '<p>The most common issue isn\'t the covering itself - it\'s a shadow it casts across the forehead or cheeks. Use even, frontal lighting rather than an overhead or side light source to avoid this.</p>' },
    ],
    faqs: [
      { q: 'Does this apply to all countries this tool supports?', a: 'The general principle - covering allowed, face fully visible - is consistent, but exact wording varies. Check your specific country\'s page and official source.' },
      { q: 'What about sunglasses or a covering for non-religious reasons?', a: 'Not permitted - the face must be fully visible regardless of the reason for any covering, with the specific exception most countries make for religious head coverings.' },
    ],
  },
  {
    slug: 'can-you-smile-in-a-passport-photo',
    title: 'Can You Smile in a Passport Photo?',
    metaTitle: 'Can You Smile in a Passport Photo? - Passport & Visa Photo Maker',
    metaDescription: 'Nearly every country requires a neutral expression in a passport photo - no smiling, mouth closed, eyes open. What "neutral" actually means and common mistakes.',
    answer: 'No, not really. Nearly every country this tool supports requires a neutral expression - mouth closed, eyes open, looking straight at the camera - so your face matches consistently for identity verification.',
    sections: [
      { heading: 'What "neutral" means', bodyHtml: '<p>Relaxed facial muscles, closed mouth, both eyes open and clearly visible, looking directly at the camera. Not a frown, not a smile, not a raised eyebrow.</p>' },
      { heading: 'Common mistakes', bodyHtml: '<p>A slight smirk, a tilted head, eyebrows raised in anticipation of the shutter, or eyes half-closed mid-blink. This tool\'s "Check My Photo" feature can flag some of these automatically.</p>' },
    ],
    faqs: [
      { q: 'What if I can\'t help smiling in every photo?', a: 'Take several shots and pick the most neutral one, or have someone say something neutral (not a joke) right before the shutter.' },
      { q: 'Do any countries allow a slight smile?', a: 'Guidance shifts over time and a few countries have historically been more lenient about a closed-mouth, natural expression - don\'t assume, check your specific country\'s page.' },
    ],
  },
  {
    slug: 'passport-photo-lighting',
    title: 'Passport Photo Lighting: How to Avoid Shadows',
    metaTitle: 'Passport Photo Lighting: How to Avoid Shadows - Passport & Visa Photo Maker',
    metaDescription: 'How to light a passport photo at home so the background stays shadow-free and even - face a window, avoid direct flash and overhead lighting.',
    answer: 'Face a soft, even light source - like a window with diffused daylight - straight on. Avoid direct sun, a single overhead lamp, on-camera flash, and any light source behind you, all of which cast the shadows that are one of the most common rejection reasons.',
    sections: [
      { heading: 'What works', bodyHtml: '<p>An overcast day near a window, or two lamps at roughly equal distance on either side of the camera, both pointed at your face rather than the wall behind you.</p>' },
      { heading: 'What to avoid', bodyHtml: '<ul class="seo-checklist"><li>Direct sunlight - too harsh, creates strong shadows and squinting.</li><li>A single light source to one side - lights half your face, shadows the other and the wall behind you.</li><li>On-camera flash pointed straight at a wall behind you - creates a hard shadow outline.</li><li>Backlighting (a window or light behind you) - silhouettes your face instead of lighting it.</li></ul>' },
    ],
    faqs: [
      { q: 'Can I fix bad lighting afterward with editing?', a: 'Not for a US passport photo - as of 2026, State Department guidance treats that as an unacceptable alteration. See our <a href="/guides/ai-edited-passport-photos-2026.html">AI-editing guide</a>. Get the lighting right when you take the photo instead.' },
      { q: 'Does the background need its own light?', a: 'It needs to be evenly lit with no shadow falling on it - usually a side effect of lighting your face evenly from the front, rather than a separate light setup.' },
    ],
  },
  {
    slug: 'online-passport-renewal-photo',
    title: 'Online Passport Renewal Photo Requirements',
    metaTitle: 'Online Passport Renewal Photo Requirements (2026) - Passport & Visa Photo Maker',
    metaDescription: 'The U.S. online passport renewal system wants a square digital upload, not the standard 2x2in print size - pixel dimensions, file size, and format explained.',
    answer: 'A different spec than the printed photo: renewing online through the State Department\'s online renewal system asks for a square digital upload, reported as 600&times;600 to 1200&times;1200 pixels and 54KB-10MB, on a plain white or off-white background - not the 2&times;2 in. / 51&times;51mm print dimensions used for a mailed application or an in-person photo.',
    sections: [
      {
        heading: 'Why it\'s a different spec',
        bodyHtml: '<p>A mailed or in-person passport photo is specified as a physical print: 2&times;2 inches (51&times;51mm) at a given DPI. The online renewal system instead asks you to upload a digital file directly, so its spec is pixel-based and square instead - there\'s no DPI or physical print size involved once it\'s a straight digital upload.</p>',
      },
      {
        heading: 'What multiple 2026 guides report',
        bodyHtml: '<p>The State Department\'s own renewal-upload page returned an access-denied response when we tried to fetch it directly, so we can\'t quote it verbatim - the figures below are corroborated across several independent 2026 guides rather than confirmed against the primary source. Always check the live upload screen when you actually renew, since it will tell you immediately if a file is rejected.</p><ul class="seo-checklist"><li><strong>Dimensions:</strong> square (1:1), reported as 600&times;600 px minimum up to 1200&times;1200 px maximum.</li><li><strong>File size:</strong> reported as 54 KB minimum, 10 MB maximum.</li><li><strong>Format:</strong> JPEG is the most consistently reported safe choice; some guides also list PNG, HEIC, and HEIF as accepted.</li><li><strong>Background:</strong> plain white or off-white, same as the printed photo.</li><li><strong>Head height:</strong> reported as roughly 50-69% of the total image height.</li></ul>',
      },
      {
        heading: 'How to get a square export from this tool',
        bodyHtml: '<p>This tool\'s templates (including the printed US template) export a rectangular size in millimeters, not a square pixel size - for a square digital upload, use <strong>Custom Size</strong> instead: set both width and height to the <em>same</em> value (76mm at the default 300 DPI export is a convenient square, comfortably inside the reported 600-1200px window), upload your photo, crop, and export the single photo file (not the print sheet). Check the exported file\'s pixel dimensions before uploading, since the exact output depends on DPI.</p>',
      },
    ],
    faqs: [
      { q: 'Can I use the same photo for a mailed application and an online renewal?', a: 'Not directly - they\'re specified differently (a rectangular print size vs. a square digital upload). Export each format separately from the same source photo rather than trying to reuse one file for both.' },
      { q: 'Does Compliance Mode apply to the online renewal upload too?', a: 'The no-AI-alteration policy is the same regardless of how you submit - a digitally altered background is treated as unacceptable whether you\'re mailing a print or uploading a file.' },
      { q: 'What if my upload gets rejected by the online system?', a: 'The online system typically gives an immediate reason (wrong dimensions, background, expression). Recheck against the figures above and your original photo\'s lighting and background before re-exporting.' },
    ],
  },
  {
    slug: 'passport-photo-privacy',
    dir: 'privacy',
    title: 'Why In-Browser Passport Photo Processing Matters',
    metaTitle: 'Passport Photo Privacy: Why In-Browser Processing Matters - Passport & Visa Photo Maker',
    metaDescription: 'Most online passport photo tools upload your face to a server. This one processes entirely in your browser - the photo never leaves your device. Here\'s what that means and how to verify it.',
    answer: 'A passport photo means uploading a picture of your face and identity to a government form - many free online tools ask you to upload that same photo to their own server first, to run the cropping and background removal. This tool doesn\'t: cropping, background removal, and face alignment all run locally in your browser, and the only network requests they make are to download the (non-photo) AI model files, never your photo.',
    sections: [
      {
        heading: 'What "runs in your browser" actually means',
        bodyHtml: '<p>Every step - reading the uploaded file, detecting your face, removing the background, cropping to the exact size, and exporting the final file - happens using your device\'s own processing power, via WebAssembly and in-browser AI models (ONNX Runtime Web and MediaPipe). Nothing about your photo is sent anywhere. Compare that to a typical "upload your photo" tool, where the file has to reach a server before anything can happen to it.</p>',
      },
      {
        heading: 'How to verify this yourself, not just take our word for it',
        bodyHtml: '<p>This is a genuinely checkable claim, not a marketing line: the project is open source. You can read the code that handles your photo directly, or open your browser\'s network tab while using the tool and watch for yourself - the only requests you\'ll see are for the app\'s own files and the AI model downloads (identifiable by their size, tens of megabytes, unrelated to any photo you\'ve loaded), never a photo upload.</p><p><a href="https://github.com/georgeputhean/passport-photo-maker" target="_blank" rel="noreferrer">View the source on GitHub &rarr;</a></p>',
      },
      {
        heading: 'What does leave your device',
        bodyHtml: '<p>Two things, neither of which is your photo: the AI model files themselves (downloaded once per session so background removal and auto-align can run locally), and standard site analytics (page views, not photo content) if you accept the cookie banner. See the <a href="/privacy-policy.html">full Privacy Policy</a> for the complete detail on analytics, ads, and cookies.</p>',
      },
    ],
    faqs: [
      { q: 'Is my photo ever stored anywhere?', a: 'Not by this site - it exists only in your browser\'s memory while you\'re editing, and is discarded when you close the tab or navigate away. There\'s no server-side storage to store it in.' },
      { q: 'Does this apply to the background-removal / AI features too, not just cropping?', a: 'Yes - background removal and auto-align both run through the same in-browser models, not a server call.' },
      { q: 'Why do other tools upload the photo to a server?', a: 'Server-side processing can be simpler to build and doesn\'t depend on the visitor\'s device having enough power to run AI models locally. The tradeoff is that your photo has to leave your device - increasingly a real concern for a photo tied to a government ID application.' },
    ],
  },
]

// Derive GUIDE_PAGES' entries for the info-guide and size-group pages from their
// own arrays, so adding a guide there doesn't also require hand-editing GUIDE_PAGES.
GUIDE_PAGES.push(...INFO_GUIDES.map((g) => ({ slug: g.slug, title: g.title, dir: g.dir || 'guides' })))
GUIDE_PAGES.push(...SIZE_GROUP_PAGES.map((g) => ({ slug: g.slug, title: g.title, dir: g.dir || 'guides' })))

function renderBabyPhotoGuidePage() {
  const bodyHtml = `
<nav class="seo-breadcrumb"><a href="/">Home</a> / Baby &amp; newborn passport photo</nav>
<h1>Baby and Newborn Passport Photo: How to Get It Right</h1>
<p><strong>A baby or newborn passport photo follows the same size and background rules as an adult's, with one common allowance: many countries permit the baby's eyes to be closed and don't require the strict "no expression" rule adults face - check your specific country's page for the exact wording.</strong></p>
<h2>Two ways to take it</h2>
<ul class="seo-checklist">
  <li><strong>Lying down, photographed from above:</strong> lay the baby on a plain white sheet or blanket and photograph straight down from directly overhead. This avoids needing anyone to hold the baby upright.</li>
  <li><strong>Held against a wall:</strong> have a parent hold the baby in front of a plain background, then crop the photo so no part of the parent - hands, arms, clothing - is visible in the final frame.</li>
</ul>
<h2>Common problems</h2>
<ul class="seo-checklist">
  <li>A shadow from whoever is holding the baby falling across the background.</li>
  <li>A patterned blanket, toy, or pacifier visible in frame.</li>
  <li>The baby's hand or hair covering part of the face.</li>
  <li>Low resolution from cropping in tightly on a photo taken from far away - get physically close instead of digitally zooming.</li>
</ul>
<a class="seo-cta" href="/">Make a compliant photo now &rarr;</a>
${renderAdSlot('incontent')}
<h2>FAQ</h2>
<div class="seo-faq-item"><h3>Do baby passport photos need open eyes?</h3><p>Varies by country - many explicitly allow closed eyes for infants since keeping them open on demand is often impractical. Check your specific country's page for the rule.</p></div>
<div class="seo-faq-item"><h3>Can a parent hold the baby in the photo?</h3><p>Generally yes, but the parent's hands, arms, and any other part of them must not be visible in the final cropped photo - only the baby.</p></div>
<div class="seo-faq-item"><h3>Can I use a car seat or stroller as a prop?</h3><p>Not directly in frame - drape a plain white sheet over it first so only a plain background shows behind the baby.</p></div>
${renderAdSlot('footer')}
`
  return renderLayout({
    title: 'Baby and Newborn Passport Photo Guide - Passport & Visa Photo Maker',
    description: 'How to take a compliant baby or newborn passport photo: two practical methods, common mistakes, and what rules differ from an adult photo.',
    canonicalPath: '/guides/baby-newborn-passport-photo.html',
    ldJson: [{
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: [
        { '@type': 'Question', name: 'Do baby passport photos need open eyes?', acceptedAnswer: { '@type': 'Answer', text: 'Varies by country - many explicitly allow closed eyes for infants since keeping them open on demand is often impractical. Check your specific country\'s page for the rule.' } },
        { '@type': 'Question', name: 'Can a parent hold the baby in the photo?', acceptedAnswer: { '@type': 'Answer', text: 'Generally yes, but the parent\'s hands, arms, and any other part of them must not be visible in the final cropped photo - only the baby.' } },
        { '@type': 'Question', name: 'Can I use a car seat or stroller as a prop?', acceptedAnswer: { '@type': 'Answer', text: 'Not directly in frame - drape a plain white sheet over it first so only a plain background shows behind the baby.' } },
      ],
    }],
    bodyHtml,
  })
}

function renderPhonePhotoGuidePage() {
  const faqs = [
    { q: 'Does the photo need to be a certain resolution?', a: 'Higher is better going in - this tool crops and resizes down to the exact pixel dimensions required, but it can\'t add detail that wasn\'t captured. A modern phone\'s default photo mode is more than enough.' },
    { q: 'Should I use flash?', a: 'Generally no - direct flash often creates a hard shadow on the wall behind you. Even room or window light usually looks better. See our <a href="/guides/passport-photo-lighting.html">lighting guide</a>.' },
  ]
  const bodyHtml = `
<nav class="seo-breadcrumb"><a href="/">Home</a> / Take a passport photo with your phone</nav>
<h1>How to Take a Passport Photo with Your Phone</h1>
<p><strong>Use the rear camera (not the front-facing one), turn off portrait mode and any beauty filter, and shoot straight-on against a plain wall in even light - this tool handles the cropping and sizing once you upload the result.</strong></p>
<ol class="seo-steps">
  <li><strong>Use the rear camera.</strong> It's almost always higher resolution than the front-facing camera, which matters once the photo is cropped down to a small passport-photo frame.</li>
  <li><strong>Turn off portrait mode and any beauty/smoothing filter.</strong> Portrait mode's background blur and any skin-smoothing or retouching filter count as digital alteration - see our <a href="/guides/ai-edited-passport-photos-2026.html">AI-editing guide</a> for why that matters for a US application specifically.</li>
  <li><strong>Stand about 3-6 feet from a plain, light-colored wall</strong>, with the phone held at eye level - propped on a stand or held by someone else, since a selfie-length arm is usually too close.</li>
  <li><strong>Use a timer or a second person to press the shutter</strong> so you can stand naturally with both arms relaxed instead of one arm reaching for the phone.</li>
  <li><strong>Check the shot before moving on</strong> - zoom in on the preview to confirm it's in focus and no shadow falls on the wall behind you.</li>
</ol>
<a class="seo-cta" href="/">Upload your photo and make it compliant &rarr;</a>
${renderAdSlot('incontent')}
<h2>FAQ</h2>
${faqs.map((f) => `<div class="seo-faq-item"><h3>${escapeHtml(f.q)}</h3><p>${f.a}</p></div>`).join('\n')}
${renderAdSlot('footer')}
`
  return renderLayout({
    title: 'How to Take a Passport Photo with Your Phone - Passport & Visa Photo Maker',
    description: 'Camera settings, distance, and lighting for a phone-taken passport photo that will actually crop and size correctly - no portrait mode, no filters.',
    canonicalPath: '/guides/take-passport-photo-with-phone.html',
    ldJson: [
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_URL}/` },
          { '@type': 'ListItem', position: 2, name: 'Take a passport photo with your phone', item: `${SITE_URL}/guides/take-passport-photo-with-phone.html` },
        ],
      },
      {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        // f.a intentionally not escaped for the schema text either - it matches
        // the visible HTML above, which contains an inline <a> link.
        mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a.replace(/<[^>]+>/g, '') } })),
      },
    ],
    bodyHtml,
  })
}

function renderBackgroundColorGuidePage(entries) {
  const rows = entries.map(({ template, content }) => {
    const background = BACKGROUND_LABELS[template.title] || 'See page'
    return `    <tr><th><a href="/photos/${content.slug}.html">${escapeHtml(content.h1.replace(' Size and Requirements', ''))}</a></th><td>${escapeHtml(background)}</td></tr>`
  }).join('\n')
  const faqs = [
    { q: 'Can the background be off-white or cream instead of pure white?', a: 'For most countries, yes - "white" in practice usually tolerates a slightly warm or cool cast from ordinary lighting. A small number of countries (see the table above) specifically require light grey or light blue instead, and at least one - France - explicitly prohibits white outright. Check your specific document.' },
    { q: 'Why do some countries require a colored background instead of white?', a: 'It\'s a national choice, not an ICAO-wide standard - some countries specify light grey or light blue for better contrast against light clothing or skin tones, or simply to make their photos visually distinct. There\'s no single universal rule.' },
    { q: 'What actually counts as a "shadow" that gets a photo rejected?', a: 'Any visible gradient or dark patch on the background or face, most often cast by a single overhead or side light source, or by standing too close to the wall behind you. It doesn\'t need to be dramatic - a faint gradient is enough to trigger a rejection at some agencies. See our lighting guide below.' },
    { q: 'Can I use a bedsheet or poster board as a background?', a: 'Yes, as long as it\'s a single uniform color with no pattern, wrinkles-as-shadows, or sheen that catches a reflection. A large piece of matte poster board taped flat to a wall is a reliable, cheap option; a sheet works if it\'s pulled taut.' },
  ]
  const bodyHtml = `
<nav class="seo-breadcrumb"><a href="/">Home</a> / Passport photo background color</nav>
<h1>What Background Color Do Passport Photos Need?</h1>
<p><strong>Almost always plain white, off-white, or another light, uniform color like light grey or cream - with no shadows, patterns, or texture. The exact shade varies by country.</strong></p>
<table class="seo-spec">
  <tbody>
${rows}
  </tbody>
</table>
<p class="seo-source-note">These are short summaries; see each document's own page for the full requirement and official source. For every size and DPI requirement in one sortable table, see the <a href="/guides/passport-photo-size-chart.html">full size chart</a>.</p>
<h2>Why background color is specified so precisely</h2>
<p>Passport and visa photos increasingly feed automated facial-recognition and biometric matching systems, not just human reviewers. A cluttered, patterned, or unevenly lit background makes it harder for that software to isolate your face cleanly - which is also why a shadow across the background, not just your face, is a common rejection reason even when your expression and framing are otherwise fine.</p>
<h2>Common background mistakes</h2>
<ul class="seo-checklist">
  <li><strong>A shadow cast by the subject</strong> - the single most common issue, usually from an overhead light or a light source behind and to one side of you rather than facing you.</li>
  <li><strong>A textured or patterned wall</strong> - brick, wood paneling, wallpaper, or a visible door frame or light switch in the shot.</li>
  <li><strong>A gradient from uneven lighting</strong> - one side of the background noticeably brighter than the other, even without a hard-edged shadow.</li>
  <li><strong>Clothing that blends into the background</strong> - a white or light-colored top against a white background can make your shoulders and neckline hard to distinguish.</li>
  <li><strong>Colors outside what's accepted</strong> - a colored wall, a visible plant, furniture, or another person in frame.</li>
</ul>
<h2>How to get an even background</h2>
<p>A real plain wall, evenly lit, works better than trying to fix a patterned or shadowed background afterward - see our <a href="/guides/passport-photo-lighting.html">lighting guide</a>. If you don't have a suitable plain wall, a large sheet of matte poster board or a taut, unpatterned sheet works as a backdrop - just make sure it's fully out of shadow itself. This tool's background removal can also replace the background entirely, though for some countries (the US specifically, as of 2026) that's not accepted - see the <a href="/guides/ai-edited-passport-photos-2026.html">AI-editing guide</a>.</p>
<a class="seo-cta" href="/">Make a compliant photo now &rarr;</a>
${renderAdSlot('incontent')}
<h2>FAQ</h2>
${faqs.map((f) => `<div class="seo-faq-item"><h3>${escapeHtml(f.q)}</h3><p>${escapeHtml(f.a)}</p></div>`).join('\n')}
${renderAdSlot('footer')}
`
  return renderLayout({
    title: 'Passport Photo Background Color by Country - Passport & Visa Photo Maker',
    description: 'What background color each country requires for a passport or visa photo - almost always plain white or another light, uniform color.',
    canonicalPath: '/guides/passport-photo-background-color.html',
    ldJson: [
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_URL}/` },
          { '@type': 'ListItem', position: 2, name: 'Passport photo background color', item: `${SITE_URL}/guides/passport-photo-background-color.html` },
        ],
      },
      {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
      },
      {
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: 'What Background Color Do Passport Photos Need?',
        description: 'What background color each country requires for a passport or visa photo - almost always plain white or another light, uniform color.',
        dateModified: BUILD_DATE,
      },
    ],
    bodyHtml,
  })
}

const REJECTION_REASONS = [
  { reason: 'Digital alteration (background replaced, skin smoothed, AI-edited)', detail: 'Increasingly the top cause for US applications specifically - as of 2026, State Department guidance treats any software/AI alteration, including background replacement, as unacceptable and checks for it.', link: { href: '/guides/ai-edited-passport-photos-2026.html', label: 'Full AI-editing rules' } },
  { reason: 'Non-neutral expression, or eyes closed', detail: 'A slight smile, raised eyebrows, or a mid-blink shot are all common, easy-to-miss mistakes - take several shots and pick the most neutral one.', link: { href: '/guides/can-you-smile-in-a-passport-photo.html', label: 'What "neutral" means' } },
  { reason: 'Shadow or uneven lighting on the background or face', detail: 'A single light source, on-camera flash, or backlighting from a window behind you all cast the shadows reviewers are specifically trained to catch.', link: { href: '/guides/passport-photo-lighting.html', label: 'How to light it correctly' } },
  { reason: 'Wrong or non-uniform background color', detail: 'A patterned wall, a colored background outside the accepted range, or a background that isn\'t evenly lit.', link: { href: '/guides/passport-photo-background-color.html', label: 'Background color by country' } },
  { reason: 'Glasses causing glare or obscuring the eyes', detail: 'A growing number of countries now discourage or disallow glasses entirely because of facial-recognition interference, not just glare.', link: { href: '/guides/passport-photo-glasses.html', label: 'Glasses rules' } },
  { reason: 'Head covering obscuring part of the face', detail: 'Religious head coverings are generally fine as long as the full face - chin to forehead - is visible with no shadow from the covering itself.', link: { href: '/guides/passport-photo-head-covering.html', label: 'Head covering rules' } },
  { reason: 'Wrong size, head position, or cropping', detail: 'Head too large, too small, or off-center within the frame relative to the document\'s exact spec.', link: { href: '/photos/', label: 'Every country\'s exact size' } },
  { reason: 'Blurry or low-resolution photo', detail: 'Often caused by digitally zooming in on a photo taken from far away instead of physically standing closer.', link: { href: '/guides/take-passport-photo-with-phone.html', label: 'Taking it with your phone' } },
  { reason: 'Photo is too old', detail: 'Most documents require a photo taken within the last 6 months - check the specific age limit on your document\'s page.', link: { href: '/photos/', label: 'Country-specific rules' } },
  { reason: 'Wrong file size or dimensions for a digital upload', detail: 'An online-renewal upload has a different pixel/file-size spec than a printed photo - uploading the print-sized file is a common mismatch.', link: { href: '/guides/online-passport-renewal-photo.html', label: 'Online renewal photo spec' } },
]

function renderRejectedGuidePage() {
  const items = REJECTION_REASONS.map((r, i) => `  <li><strong>${escapeHtml(r.reason)}.</strong> ${escapeHtml(r.detail)} <a href="${r.link.href}">${escapeHtml(r.link.label)} &rarr;</a></li>`).join('\n')
  const faqs = [
    { q: 'How do I know why my specific photo was rejected?', a: 'A rejection notice doesn\'t always give the exact reason. Work through the list above in order - digital alteration and expression/lighting issues are the most common causes - and use this tool\'s built-in "🔍 Check Photo" feature before resubmitting, which flags several of these automatically.' },
    { q: 'Can I fix a rejected photo, or do I need to retake it?', a: 'It depends on the cause. Sizing and cropping can be fixed from the same photo. Lighting, shadows, expression, and background issues generally can\'t be fixed after the fact without counting as digital alteration - retake the photo instead.' },
    { q: 'Does this tool guarantee my photo will be accepted?', a: 'No tool can guarantee acceptance - final review is up to the issuing authority. This tool handles the size, DPI, and background requirements precisely and flags common issues, which addresses most rejection causes, but always compare against the official source linked on your document\'s page before submitting.' },
  ]
  const bodyHtml = `
<nav class="seo-breadcrumb"><a href="/">Home</a> / Passport photo rejected</nav>
<h1>Passport Photo Rejected? Here's Why, and How to Fix It</h1>
<p><strong>The most common causes, in roughly the order we'd check them: digital alteration (including background removal), a non-neutral expression, lighting/shadow problems, a wrong or non-uniform background, glasses, an obscured face, incorrect size or cropping, low resolution, an outdated photo, or - for an online upload specifically - the wrong file size or pixel dimensions.</strong></p>
<h2>Work through these in order</h2>
<ol class="seo-steps">
${items}
</ol>
<h2>Check before you resubmit</h2>
<p>This tool's built-in <strong>"🔍 Check Photo"</strong> feature runs several of these checks automatically against your uploaded photo - face detection, eyes/expression, head tilt, and a couple of lower-confidence heuristics for glasses and covered ears - before you export. It's not a substitute for reviewing the official requirements yourself, but it catches a meaningful share of the common mistakes above.</p>
<a class="seo-cta" href="/">Make a corrected photo now &rarr;</a>
${renderAdSlot('incontent')}
<h2>FAQ</h2>
${faqs.map((f) => `<div class="seo-faq-item"><h3>${escapeHtml(f.q)}</h3><p>${escapeHtml(f.a)}</p></div>`).join('\n')}
${renderAdSlot('footer')}
`
  return renderLayout({
    title: 'Passport Photo Rejected? Common Reasons and How to Fix It',
    description: 'The most common reasons a passport or visa photo gets rejected - digital alteration, expression, lighting, background, and sizing - and how to fix each one.',
    canonicalPath: '/guides/passport-photo-rejected.html',
    ldJson: [{
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
    }],
    bodyHtml,
  })
}

// Positioning claims here are about what's generally, durably true of the free
// passport-photo-tool category (server-upload vs. in-browser, watermarked vs.
// not, country-count order of magnitude) rather than specific prices or feature
// lists for named competitors, which drift and which we haven't independently
// re-verified against each site at build time - see RETAILERS above for the
// stricter primary/secondary sourcing bar applied where we do cite a number.
function renderCompareGuidePage() {
  const bodyHtml = `
<nav class="seo-breadcrumb"><a href="/">Home</a> / Best free passport photo makers</nav>
<h1>Best Free Passport Photo Makers, Compared</h1>
<p><strong>Most "free" passport photo tools are free to crop, but charge for the print-ready sheet, add a watermark, or require an account - and nearly all of them upload your photo to a server to process it. What to check before you pick one.</strong></p>
<h2>What actually varies between these tools</h2>
<ul class="seo-checklist">
  <li><strong>Where your photo is processed.</strong> Most free tools upload your photo to a server to crop and remove the background, then send back a result - meaning a copy of your photo passes through their infrastructure. A smaller number process entirely in your browser, so the photo never leaves your device. This is a genuinely checkable difference, not a marketing claim: open your browser's network tab while using a tool and watch what it actually sends.</li>
  <li><strong>Whether "free" includes the print sheet.</strong> Many tools let you crop for free but charge to unlock a printable multi-photo sheet or remove a watermark - effectively making the useful output paid.</li>
  <li><strong>Country/document coverage.</strong> Ranges widely across tools in this space, from a handful of major countries to 50+; check the specific tool's current list rather than a marketing headline, since coverage changes.</li>
  <li><strong>Whether it's open source.</strong> Rare in this category. Being able to read the actual code that handles your photo is a stronger privacy guarantee than a privacy-policy paragraph.</li>
</ul>
<h2>Where this tool stands</h2>
<ul class="seo-checklist">
  <li>Processes entirely in your browser - see our <a href="/privacy/passport-photo-privacy.html">privacy page</a> for how to verify that yourself.</li>
  <li>Free, unwatermarked, no account required, including the print-sheet export.</li>
  <li>Open source - <a href="https://github.com/georgeputhean/passport-photo-maker" target="_blank" rel="noreferrer">the code is public</a>.</li>
  <li>Compliance Mode / Edit Mode split for the US template, so background removal isn't offered by default where it could get an application rejected - see our <a href="/guides/ai-edited-passport-photos-2026.html">AI-editing guide</a>.</li>
</ul>
<p>We're not neutral here - we built this tool. Judge the specific claims above (upload behavior, pricing, watermarking, open-source-ness) against whatever alternative you're considering rather than taking either side's word for it; most are directly checkable in a couple of minutes.</p>
<a class="seo-cta" href="/">Try it free &rarr;</a>
${renderAdSlot('footer')}
`
  return renderLayout({
    title: 'Best Free Passport Photo Makers, Compared - Passport & Visa Photo Maker',
    description: 'What actually varies between free passport photo tools - server upload vs. in-browser processing, watermarking, print-sheet pricing, and open-source availability.',
    canonicalPath: '/compare/best-free-passport-photo-makers.html',
    ldJson: [
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_URL}/` },
          { '@type': 'ListItem', position: 2, name: 'Best free passport photo makers', item: `${SITE_URL}/compare/best-free-passport-photo-makers.html` },
        ],
      },
      {
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: 'Best Free Passport Photo Makers, Compared',
        description: 'What actually varies between free passport photo tools - server upload vs. in-browser processing, watermarking, print-sheet pricing, and open-source availability.',
        dateModified: BUILD_DATE,
      },
    ],
    bodyHtml,
  })
}

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

// The consent-mode default (deny) fires first, then the AdSense library script
// loads unconditionally and statically - not gated behind a consent click. This
// matches Google's own Consent Mode v2 pattern: the library itself reads the
// consent signals set above and serves limited/non-personalized ads rather than
// nothing when consent is denied, so blocking it entirely isn't required for
// compliance. It also has to be present as static markup (not JS-injected after
// a click) for Google's AdSense site-verification crawler to find it - a
// click-gated <script> tag never shows up in the raw HTML it fetches.
function adsenseLibraryScriptTag() {
  return `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT_ID}" crossorigin="anonymous" data-adsbygoogle-loader="true"></script>`
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
</script>
${adsenseLibraryScriptTag()}`
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

// Writes a guide-like page to public/<dir>/<slug>.html, creating <dir> on demand -
// lets guide pages live outside public/guides/ (e.g. public/sizes/, public/compare/,
// public/privacy/) without every call site needing its own mkdirSync.
function writePage(dir, slug, html) {
  const dirPath = path.join(PUBLIC_DIR, dir)
  fs.mkdirSync(dirPath, { recursive: true })
  fs.writeFileSync(path.join(dirPath, `${slug}.html`), html)
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

// Same guide-title matching AutoAlign.js uses to find the crown/chin target
// bands - kept as a separate constant here rather than imported, matching
// this file's existing pattern of not sharing internal constants across
// scripts/ and src/ (they're built and run in different environments).
const DIAGRAM_HEAD_TOP_GUIDES = ['Bar: Top', 'Top Head Area']
const DIAGRAM_CHIN_GUIDES = ['Bar: Bottom', 'Center Square: bottom']

// A data-driven, illustrative size/position diagram per document, generated
// from the same template.guide data the in-app editor uses for its own
// alignment bars - not a real photo (avoids any licensing/likeness issue),
// but genuinely derived from this tool's actual spec rather than a generic
// stock graphic. Addresses the site having zero images despite "passport
// photo size" being a query that returns image-pack results.
function renderDimensionDiagramSvg(template, content, spec) {
  const CANVAS_W = 640
  const CANVAS_H = 760
  const MAX_FRAME_W = 340
  const MAX_FRAME_H = 460
  const aspect = spec.widthMm / spec.heightMm
  let frameW = MAX_FRAME_W
  let frameH = frameW / aspect
  if (frameH > MAX_FRAME_H) {
    frameH = MAX_FRAME_H
    frameW = frameH * aspect
  }
  const frameX = (CANVAS_W - frameW) / 2
  const frameY = 100

  const background = BACKGROUND_LABELS[template.title] || 'light, uniform'
  const title = escapeHtml(content.h1.replace(' Size and Requirements', ''))

  const topGuide = (template.guide || []).find((g) => DIAGRAM_HEAD_TOP_GUIDES.includes(g.title))
  const bottomGuide = (template.guide || []).find((g) => DIAGRAM_CHIN_GUIDES.includes(g.title))

  let headMarkup = ''
  if (topGuide && bottomGuide) {
    // Guide coordinates are in 0.1mm units (see AutoAlign.js) - the same
    // convention every template.guide array already uses for the in-app bars.
    const totalGuideH = spec.heightMm * 10
    const topCenter = (parseFloat(topGuide.start_y) + parseFloat(topGuide.height) / 2) / totalGuideH
    const bottomCenter = (parseFloat(bottomGuide.start_y) + parseFloat(bottomGuide.height) / 2) / totalGuideH
    const crownY = frameY + topCenter * frameH
    const chinY = frameY + bottomCenter * frameH
    const headCenterX = frameX + frameW / 2
    const headHeight = chinY - crownY
    const headWidth = headHeight * 0.72
    const shoulderY = chinY + headHeight * 0.35

    headMarkup = `
  <line x1="${frameX}" y1="${crownY.toFixed(1)}" x2="${frameX + frameW}" y2="${crownY.toFixed(1)}" stroke="#f5c518" stroke-width="1.5" stroke-dasharray="3,3"/>
  <line x1="${frameX}" y1="${chinY.toFixed(1)}" x2="${frameX + frameW}" y2="${chinY.toFixed(1)}" stroke="#f5c518" stroke-width="1.5" stroke-dasharray="3,3"/>
  <path d="M ${(headCenterX - headWidth * 0.85).toFixed(1)} ${(frameY + frameH).toFixed(1)} Q ${(headCenterX - headWidth * 0.85).toFixed(1)} ${shoulderY.toFixed(1)} ${headCenterX.toFixed(1)} ${shoulderY.toFixed(1)} Q ${(headCenterX + headWidth * 0.85).toFixed(1)} ${shoulderY.toFixed(1)} ${(headCenterX + headWidth * 0.85).toFixed(1)} ${(frameY + frameH).toFixed(1)}" fill="none" stroke="#93c5fd" stroke-width="2.5" stroke-dasharray="5,4"/>
  <ellipse cx="${headCenterX.toFixed(1)}" cy="${((crownY + chinY) / 2).toFixed(1)}" rx="${(headWidth / 2).toFixed(1)}" ry="${(headHeight / 2).toFixed(1)}" fill="none" stroke="#93c5fd" stroke-width="2.5" stroke-dasharray="5,4"/>
  <text x="${frameX + frameW + 14}" y="${(crownY + 5).toFixed(1)}" font-family="Arial, Helvetica, Liberation Sans, sans-serif" font-size="15" fill="#f5c518">Crown target</text>
  <text x="${frameX + frameW + 14}" y="${(chinY + 5).toFixed(1)}" font-family="Arial, Helvetica, Liberation Sans, sans-serif" font-size="15" fill="#f5c518">Chin target</text>`
  }

  return `<svg width="${CANVAS_W}" height="${CANVAS_H}" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${CANVAS_W}" height="${CANVAS_H}" fill="#0f172a"/>
  <text x="${CANVAS_W / 2}" y="45" text-anchor="middle" font-family="Arial, Helvetica, Liberation Sans, sans-serif" font-size="24" font-weight="700" fill="#ffffff">${title}</text>
  <rect x="${frameX.toFixed(1)}" y="${frameY}" width="${frameW.toFixed(1)}" height="${frameH.toFixed(1)}" fill="#f8fafc" stroke="#475569" stroke-width="2"/>${headMarkup}
  <text x="${(frameX + frameW / 2).toFixed(1)}" y="${frameY - 18}" text-anchor="middle" font-family="Arial, Helvetica, Liberation Sans, sans-serif" font-size="18" fill="#e2e8f0">${spec.widthMm} mm (${spec.widthIn}")</text>
  <text x="${(frameX - 18).toFixed(1)}" y="${(frameY + frameH / 2).toFixed(1)}" text-anchor="middle" font-family="Arial, Helvetica, Liberation Sans, sans-serif" font-size="18" fill="#e2e8f0" transform="rotate(-90 ${(frameX - 18).toFixed(1)} ${(frameY + frameH / 2).toFixed(1)})">${spec.heightMm} mm (${spec.heightIn}")</text>
  <text x="${CANVAS_W / 2}" y="${(frameY + frameH + 55).toFixed(1)}" text-anchor="middle" font-family="Arial, Helvetica, Liberation Sans, sans-serif" font-size="18" fill="#e2e8f0">Background: ${escapeHtml(background)}</text>
  <text x="${CANVAS_W / 2}" y="${(frameY + frameH + 84).toFixed(1)}" text-anchor="middle" font-family="Arial, Helvetica, Liberation Sans, sans-serif" font-size="15" fill="#94a3b8">${spec.dpi} DPI &#183; ${spec.widthPx} &#215; ${spec.heightPx} px &#183; max ${spec.maxSizeKb} KB</text>
  <text x="${CANVAS_W / 2}" y="${CANVAS_H - 40}" text-anchor="middle" font-family="Arial, Helvetica, Liberation Sans, sans-serif" font-size="13" fill="#64748b">
    <tspan x="${CANVAS_W / 2}" dy="0">Illustrative diagram generated from this tool's own spec data,</tspan>
    <tspan x="${CANVAS_W / 2}" dy="18">not to exact scale - see the table above for the authoritative numbers.</tspan>
  </text>
</svg>`
}

async function generateDimensionDiagram(template, content, spec) {
  const svg = renderDimensionDiagramSvg(template, content, spec)
  await sharp(Buffer.from(svg)).png().toFile(path.join(DIAGRAMS_DIR, `${content.slug}-passport-photo-dimensions.png`))
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
  <span><a href="/photos/">All countries</a> &middot; <a href="/guides/">Guides</a> &middot; <a href="/about.html">About</a> &middot; <a href="/methodology.html">Methodology</a> &middot; <a href="/contact.html">Contact</a> &middot; <a href="/privacy-policy.html">Privacy Policy</a></span>
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
  const diagramPath = `/diagrams/${content.slug}-passport-photo-dimensions.png`
  const diagramAlt = `Diagram of ${content.h1.replace(' Size and Requirements', '')}: ${spec.widthMm}x${spec.heightMm}mm with head-position guide bands`

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
    {
      '@context': 'https://schema.org',
      '@type': 'ImageObject',
      contentUrl: `${SITE_URL}${diagramPath}`,
      url: `${SITE_URL}${diagramPath}`,
      description: diagramAlt,
      width: 640,
      height: 760,
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
<img class="seo-diagram" src="${diagramPath}" alt="${escapeHtml(diagramAlt)}" width="640" height="760" loading="lazy">
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
<h1>Free Passport Photo Editor</h1>
<p><strong>Passport &amp; Visa Photo Maker</strong> is a free online passport photo editor: upload a photo and get the exact 2x2 (51x51mm) size, background, and DPI for ${entries.length} countries and document types, with an option to remove the background automatically - all processed locally in your browser, never uploaded to a server.</p>
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
</div>
<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: HOME_FAQS.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
  })}</script>`
}

function updateIndexHtml(entries) {
  const indexPath = path.join(PUBLIC_DIR, 'index.html')
  const html = fs.readFileSync(indexPath, 'utf8')

  // The <title>/og/twitter/ld+json tags above the SEO_CONTENT markers hand-write
  // the country count in prose ("for 14 Countries") rather than interpolating it,
  // since it reads better than a purely dynamic string - but that means adding a
  // country doesn't update them automatically. Warn on drift instead of silently
  // shipping a stale count, the same failure mode as the old "13 countries" bug.
  const titleMatch = html.match(/<title>[^<]*for (\d+) Countries/)
  if (titleMatch && Number(titleMatch[1]) !== entries.length) {
    console.warn(`[generate-seo] public/index.html's <title> says "${titleMatch[1]} Countries" but there are actually ${entries.length} - update the hand-written count in public/index.html's <head>.`)
  }

  const block = renderHomepageSeoBlock(entries)
  let updated = html.replace(
    /<!-- SEO_CONTENT_START -->[\s\S]*<!-- SEO_CONTENT_END -->/,
    `<!-- SEO_CONTENT_START -->\n${block}\n  <!-- SEO_CONTENT_END -->`
  )
  if (updated === html && !html.includes('SEO_CONTENT_START')) {
    console.warn('[generate-seo] public/index.html has no SEO_CONTENT markers - skipping homepage content injection.')
    return
  }

  // Same "blank env var disables it" convention as the /photos/*.html pages -
  // see adsenseLibraryScriptTag() above for why this has to be static markup.
  const adsHead = ADSENSE_CLIENT_ID ? adsenseLibraryScriptTag() : ''
  const withAds = updated.replace(
    /<!-- ADSENSE_HEAD_START -->[\s\S]*<!-- ADSENSE_HEAD_END -->/,
    `<!-- ADSENSE_HEAD_START -->\n  ${adsHead}\n  <!-- ADSENSE_HEAD_END -->`
  )
  if (withAds === updated && !updated.includes('ADSENSE_HEAD_START')) {
    console.warn('[generate-seo] public/index.html has no ADSENSE_HEAD markers - skipping homepage AdSense script injection.')
  } else {
    updated = withAds
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
    description: `Exact passport and visa photo size, background, and DPI requirements for ${entries.length} countries and document types, with a free online photo maker for each.`,
    canonicalPath: '/photos/',
    ldJson,
    bodyHtml,
  })
}

function renderGuidesIndexPage() {
  const ldJson = [{
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: GUIDE_PAGES.map((g, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: g.title,
      url: `${SITE_URL}/${g.dir || 'guides'}/${g.slug}.html`,
    })),
  }]

  const bodyHtml = `
<nav class="seo-breadcrumb"><a href="/">Home</a> / Guides</nav>
<h1>Passport Photo Guides</h1>
<p>Costs, how-tos, and rules that go beyond a single country's size and DPI spec.</p>
<ul class="seo-index-list">
${GUIDE_PAGES.map((g) => `  <li><a href="/${g.dir || 'guides'}/${g.slug}.html">${escapeHtml(g.title)}</a></li>`).join('\n')}
</ul>
`

  return renderLayout({
    title: 'Passport Photo Guides - Passport & Visa Photo Maker',
    description: 'Passport photo cost comparisons, how-to guides, and rules explainers - retailer pricing, printing at home, AI-editing rules, and more.',
    canonicalPath: '/guides/',
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
    '## Guides',
    ...GUIDE_PAGES.map((g) => `- [${g.title}](${SITE_URL}/${g.dir || 'guides'}/${g.slug}.html)`),
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
    `${SITE_URL}/guides/`,
    ...GUIDE_PAGES.map((g) => `${SITE_URL}/${g.dir || 'guides'}/${g.slug}.html`),
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

// Templates with no official spec to publish a requirements page for - not a
// missing-data bug, so excluded from the "no seoContent entry" warning below.
const NO_LANDING_PAGE_EXPECTED = new Set(['Custom Size'])

async function main() {
  const templates = loadTemplates()
  const entries = templates
    .map((template) => {
      const content = seoContent[template.title]
      if (!content) {
        if (!NO_LANDING_PAGE_EXPECTED.has(template.title)) {
          console.warn(`[generate-seo] No src/seoContent.json entry for template "${template.title}" - skipping its landing page.`)
        }
        return null
      }
      return { template, content }
    })
    .filter(Boolean)

  entries.forEach(({ template }) => {
    if (!BACKGROUND_LABELS[template.title]) {
      console.warn(`[generate-seo] No BACKGROUND_LABELS entry for template "${template.title}" - its size-chart and background-color guide rows will show "See page".`)
    }
  })

  fs.mkdirSync(PHOTOS_DIR, { recursive: true })
  fs.mkdirSync(OG_DIR, { recursive: true })
  fs.mkdirSync(DIAGRAMS_DIR, { recursive: true })
  fs.mkdirSync(GUIDES_DIR, { recursive: true })

  entries.forEach(({ template, content }) => {
    fs.writeFileSync(path.join(PHOTOS_DIR, `${content.slug}.html`), renderPhotoPage(template, content, entries))
  })

  for (const { template, content } of entries) {
    const spec = deriveSpec(template)
    await generateOgImage(content, spec)
    await generateDimensionDiagram(template, content, spec)
  }

  RETAILERS.forEach((retailer) => {
    fs.writeFileSync(path.join(GUIDES_DIR, `${retailer.slug}.html`), renderRetailerGuide(retailer))
  })
  fs.writeFileSync(path.join(GUIDES_DIR, 'passport-photo-cost.html'), renderCostComparisonPage())
  fs.writeFileSync(path.join(GUIDES_DIR, 'print-passport-photos-at-home.html'), renderPrintAtHomeGuidePage())
  fs.writeFileSync(path.join(GUIDES_DIR, 'ai-edited-passport-photos-2026.html'), renderAiEditingGuidePage())
  fs.writeFileSync(path.join(GUIDES_DIR, 'passport-photo-size-chart.html'), renderSizeChartPage(entries))
  fs.writeFileSync(path.join(GUIDES_DIR, 'baby-newborn-passport-photo.html'), renderBabyPhotoGuidePage())
  fs.writeFileSync(path.join(GUIDES_DIR, 'take-passport-photo-with-phone.html'), renderPhonePhotoGuidePage())
  fs.writeFileSync(path.join(GUIDES_DIR, 'passport-photo-background-color.html'), renderBackgroundColorGuidePage(entries))
  fs.writeFileSync(path.join(GUIDES_DIR, 'passport-photo-rejected.html'), renderRejectedGuidePage())
  writePage('compare', 'best-free-passport-photo-makers', renderCompareGuidePage())
  INFO_GUIDES.forEach((guide) => {
    writePage(guide.dir || 'guides', guide.slug, renderInfoGuidePage(guide))
  })
  SIZE_GROUP_PAGES.forEach((group) => {
    writePage(group.dir || 'guides', group.slug, renderSizeGroupPage(entries, group))
  })
  fs.writeFileSync(path.join(GUIDES_DIR, 'index.html'), renderGuidesIndexPage())

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
