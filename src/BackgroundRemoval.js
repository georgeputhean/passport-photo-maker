// @imgly/background-removal (plus its ONNX runtime) is dynamically imported
// below so it's code-split out of the main bundle - it's only fetched once a
// user actually triggers background removal, not on initial page load.
//
// model: 'small' (~44MB) instead of the 'medium' default (~88MB) - roughly
// halves the first-run download for a marginal quality difference on a
// head-and-shoulders portrait against a plain-ish wall.

// Self-hosted model first, falling back to img.ly's remote CDN if that fails.
export const removeBackground = async (photoData) => {
  const { default: imglyRemoveBackground } = await import('@imgly/background-removal')
  const configs = [
    { debug: true, model: 'small', publicPath: window.location.href + '/ai-assets/dist/' },
    { debug: true, model: 'small' },
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
