import pica from 'pica'

// A JPEG quality knob can only shrink a file, never grow it - so a minimum
// size can only be enforced by reporting a shortfall, not by padding or
// upscaling past the requested pixel dimensions. Returns { blob, belowMinSize }
// rather than a bare blob so callers can't silently miss that shortfall.
const resizeAndCompressImage = (imageData, targetWidth, targetHeight, maxSizeKB, minSizeKB) => {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.src = imageData

    img.onload = async () => {
      // Create an off-screen canvas for Pica to work with
      const offScreenCanvas = document.createElement('canvas')
      offScreenCanvas.width = targetWidth
      offScreenCanvas.height = targetHeight

      try {
        await pica().resize(img, offScreenCanvas)

        // Create another canvas to apply compression
        const compressCanvas = document.createElement('canvas')
        compressCanvas.width = targetWidth
        compressCanvas.height = targetHeight
        const ctx = compressCanvas.getContext('2d')

        // Draw white background
        ctx.fillStyle = '#FFFFFF'
        ctx.fillRect(0, 0, targetWidth, targetHeight)

        // Draw the resized image on top of the white background
        ctx.drawImage(offScreenCanvas, 0, 0, targetWidth, targetHeight)

        const blobAtQuality = (quality) => new Promise((res) => {
          compressCanvas.toBlob(res, 'image/jpeg', quality)
        })

        // Step quality down from 1.0 until the file fits under maxSizeKB, or
        // quality bottoms out at 0.
        let quality = 1.0
        let blob = await blobAtQuality(quality)
        while (blob.size / 1024 > maxSizeKB - 2 && quality > 0) {
          quality -= 0.01
          blob = await blobAtQuality(quality)
        }

        const belowMinSize = minSizeKB != null && blob.size / 1024 < minSizeKB
        resolve({ blob, belowMinSize })
      } catch (error) {
        console.error('Error processing image:', error)
        reject(error)
      }
    }

    img.onerror = () => {
      reject(new Error('Failed to load image.'))
    }
  })
}

export const generateSingle = (croppedImage, editorRef, exportPhoto) => {
  return new Promise((resolve, reject) => {
    if (editorRef && editorRef.current && croppedImage) {
      // Get the canvas from AvatarEditor
      const canvas = editorRef.current.getImage()
      const imageDataUrl = canvas.toDataURL('image/png')

      // Now use resizeAndCompressImage
      resizeAndCompressImage(imageDataUrl, exportPhoto.width, exportPhoto.height, exportPhoto.size, exportPhoto.size_min)
        .then(({ blob, belowMinSize }) => {
          const url = URL.createObjectURL(blob)
          resolve({ url, belowMinSize })
        })
        .catch((error) => {
          console.error('Error resizing and compressing image:', error)
          reject(error)
        })
    } else {
      reject(new Error("Missing required parameters"))
    }
  })
}

export const handleSaveSingle = (imageSrc) => {
  if (!imageSrc) {
    console.error('No image source provided for download.')
    return
  }
  const a = document.createElement('a')
  a.href = imageSrc
  a.download = 'resized-image.jpeg'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

// Sheet sizes offered alongside the single-photo export. 4x6in is the US
// drugstore-kiosk default; A4, 10x15cm, and Letter cover the paper sizes
// common outside the US (see the print-at-home guide's cost comparison).
export const SHEET_SIZES = [
  { key: '4x6', label: '4×6 in', widthIn: 4, heightIn: 6 },
  { key: 'a4', label: 'A4', widthIn: 210 / 25.4, heightIn: 297 / 25.4 },
  { key: '10x15', label: '10×15 cm', widthIn: 100 / 25.4, heightIn: 150 / 25.4 },
  { key: 'letter', label: 'Letter', widthIn: 8.5, heightIn: 11 },
]

// Generalized print-sheet generator - a fixed-size canvas (sheet.widthIn x
// sheet.heightIn) packed with as many copies of the cropped photo as fit,
// with dotted cut guides between them, auto-picking portrait or landscape
// orientation for whichever fits more copies.
export const generateSheet = (MM2INCH, croppedImage, exportPhoto, sheet) => {
  return new Promise((resolve, reject) => {
    if (croppedImage && exportPhoto) {
      // Define margins and spacing
      const outerMarginMM = 5 // 10 mm margin around the canvas
      const marginMM = 0.2 // 1 mm margin around each photo
      const spacingMM = 2 // 5 mm spacing between photos

      const outerMargin = outerMarginMM / MM2INCH * exportPhoto.dpi
      const margin = marginMM / MM2INCH * exportPhoto.dpi
      const spacing = spacingMM / MM2INCH * exportPhoto.dpi

      // Calculate the single photo dimensions with margin
      const photoWidth = exportPhoto.width_mm / MM2INCH * exportPhoto.dpi
      const photoHeight = exportPhoto.height_mm / MM2INCH * exportPhoto.dpi
      const photoWidthWithMargin = photoWidth + 2 * margin
      const photoHeightWithMargin = photoHeight + 2 * margin

      // Calculate potential layouts for portrait and landscape
      const portrait = calculateLayout(sheet.widthIn * exportPhoto.dpi - 2 * outerMargin, sheet.heightIn * exportPhoto.dpi - 2 * outerMargin, photoWidthWithMargin, photoHeightWithMargin, spacing)
      const landscape = calculateLayout(sheet.heightIn * exportPhoto.dpi - 2 * outerMargin, sheet.widthIn * exportPhoto.dpi - 2 * outerMargin, photoWidthWithMargin, photoHeightWithMargin, spacing)

      // Determine best orientation
      const usePortrait = (portrait.count >= landscape.count)

      // Set canvas dimensions based on best orientation
      const canvasWidth = usePortrait ? sheet.widthIn * exportPhoto.dpi : sheet.heightIn * exportPhoto.dpi
      const canvasHeight = usePortrait ? sheet.heightIn * exportPhoto.dpi : sheet.widthIn * exportPhoto.dpi

      // Create a canvas element to draw the photos
      const canvas = document.createElement('canvas')
      canvas.width = canvasWidth
      canvas.height = canvasHeight
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = 'white'
      ctx.fillRect(0, 0, canvasWidth, canvasHeight)

      // Load the image and draw it on the canvas
      const img = new Image()
      img.src = croppedImage

      img.onload = () => {
        // Calculate the starting positions
        const layout = usePortrait ? portrait : landscape
        const startX = outerMargin + (canvasWidth - 2 * outerMargin - (layout.columns * photoWidthWithMargin + (layout.columns - 1) * spacing)) / 2
        const startY = outerMargin + (canvasHeight - 2 * outerMargin - (layout.rows * photoHeightWithMargin + (layout.rows - 1) * spacing)) / 2

        // Draw the photos with margin and dotted line
        for (let i = 0; i < layout.columns; i++) {
          for (let j = 0; j < layout.rows; j++) {
            const x = startX + i * (photoWidthWithMargin + spacing)
            const y = startY + j * (photoHeightWithMargin + spacing)
            // Draw the photo
            ctx.drawImage(img, x + margin, y + margin, photoWidth, photoHeight)
            // Draw the dotted line for cutting
            drawDottedLine(ctx, x, y, photoWidthWithMargin, photoHeightWithMargin)
          }
        }

        resolve(canvas.toDataURL())
      }

      img.onerror = () => {
        reject(new Error('Failed to load the image.'))
      }
    } else {
      reject(new Error('Missing required parameters for image generation.'))
    }
  })
}

// Helper function to calculate the layout
const calculateLayout = (canvasWidth, canvasHeight, photoWidth, photoHeight, spacing) => {
  const columns = Math.floor((canvasWidth + spacing) / (photoWidth + spacing))
  const rows = Math.floor((canvasHeight + spacing) / (photoHeight + spacing))
  return {
    count: columns * rows,
    columns: columns,
    rows: rows
  }
}

// Helper function to draw dotted lines
const drawDottedLine = (ctx, x, y, width, height) => {
  const dashLength = 3
  const dashSpace = 3
  ctx.beginPath()
  ctx.setLineDash([dashLength, dashSpace])
  ctx.strokeStyle = 'lightgrey'
  ctx.rect(x, y, width, height)
  ctx.stroke()
  ctx.setLineDash([])
}


export const handleSaveSheet = (sheetImage, filename = '4x6-image.jpeg') => {
  const a = document.createElement('a')
  a.href = sheetImage
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}
