// @imgly/background-removal (plus its ONNX runtime) is dynamically imported
// below so it's code-split out of the main bundle - it's only fetched once a
// user actually triggers background removal, not on initial page load.
//
// model: 'small' (~44MB) instead of the 'medium' default (~88MB) - roughly
// halves the first-run download for a marginal quality difference on a
// head-and-shoulders portrait against a plain-ish wall.

// Turns @imgly/background-removal's per-resource progress callback
// (key, current, total - fired once per model/wasm chunk and again for the
// inference step itself) into a single aggregate 0-100 for a progress bar.
const aggregateProgress = (onPercent) => {
  if (!onPercent) return undefined
  const resources = {}
  return (key, current, total) => {
    resources[key] = { current, total }
    const totals = Object.values(resources)
    const sumCurrent = totals.reduce((sum, r) => sum + r.current, 0)
    const sumTotal = totals.reduce((sum, r) => sum + r.total, 0)
    onPercent(sumTotal > 0 ? Math.min(100, Math.round((sumCurrent / sumTotal) * 100)) : 0)
  }
}

// The model download + first-run inference takes 20s+ on a typical
// connection (~55MB of model/wasm). Auto Align and Check Photo both need a
// background-removed copy just to locate the crown of the head, so without
// this cache, clicking either one twice (or one after the other) pays that
// cost again from scratch. Single-entry, keyed on the source image - callers
// only ever have one photo loaded at a time.
let cache = null

// Self-hosted model first, falling back to img.ly's remote CDN if that fails.
export const removeBackground = (photoData, onPercent) => {
  if (cache && cache.key === photoData) return cache.promise
  const promise = runRemoveBackground(photoData, onPercent)
  cache = { key: photoData, promise }
  promise.catch(() => {
    if (cache && cache.promise === promise) cache = null
  })
  return promise
}

const runRemoveBackground = async (photoData, onPercent) => {
  const { default: imglyRemoveBackground } = await import('@imgly/background-removal')
  const progress = aggregateProgress(onPercent)
  const configs = [
    { debug: true, model: 'small', publicPath: process.env.PUBLIC_URL + '/ai-assets/dist/', progress },
    { debug: true, model: 'small', progress },
  ]

  let lastError
  for (const config of configs) {
    try {
      return await imglyRemoveBackground(photoData, config)
    } catch (error) {
      console.error('Background removal error:', error)
      lastError = error
    }
  }
  throw lastError
}
