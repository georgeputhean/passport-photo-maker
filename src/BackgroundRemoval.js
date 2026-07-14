import imglyRemoveBackground from '@imgly/background-removal'

// Self-hosted model first, falling back to img.ly's remote CDN if that fails.
export const removeBackground = async (photoData) => {
  const configs = [
    { debug: true, model: 'medium', publicPath: window.location.href + '/ai-assets/dist/' },
    { debug: true, model: 'medium' },
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
