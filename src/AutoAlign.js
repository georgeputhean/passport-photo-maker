import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import { removeBackground } from './BackgroundRemoval'

const LOCAL_ASSETS = process.env.PUBLIC_URL + '/ai-assets/mediapipe'
const REMOTE_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm'
const REMOTE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

// MediaPipe Face Mesh landmark indices
const NOSE_TIP = 1
const FOREHEAD_TOP = 10
const CHIN_BOTTOM = 152
const FACE_OVAL_LEFT = 234
const FACE_OVAL_RIGHT = 454

// The mesh's topmost landmark sits at the top of the forehead, not the crown of
// the head. Estimate the crown by extending upward by a fraction of the
// forehead-to-chin distance (anthropometric average, ignores tall hairstyles).
const HAIR_ALLOWANCE = 0.25

// Guide titles that mark where the head must fit, shared across all templates
const HEAD_TOP_GUIDES = ['Bar: Top', 'Top Head Area']
const CHIN_GUIDES = ['Bar: Bottom', 'Center Square: bottom']

// Sanity bounds only (NaN/Infinity/degenerate-input guard). Intentionally NOT
// the manual zoom slider's range (MIN_ZOOM/MAX_ZOOM) - that range exists for
// comfortable manual dragging, not as a technical ceiling. A wide-framed source
// photo legitimately needs a much larger zoom to fill the guide bars, and
// clamping to the slider range here breaks the crown/chin two-point fit (both
// end up wrong together) even though it looks like only one end is off.
const ABSOLUTE_MIN_ZOOM = 0.05
const ABSOLUTE_MAX_ZOOM = 50

let landmarkerPromise = null

const createLandmarker = async () => {
  const configs = [
    { wasm: LOCAL_ASSETS + '/wasm', model: LOCAL_ASSETS + '/face_landmarker.task' },
    { wasm: REMOTE_WASM, model: REMOTE_MODEL }, // If can't load local assets, try remote ones.
  ]

  let lastError
  for (const config of configs) {
    try {
      const fileset = await FilesetResolver.forVisionTasks(config.wasm)
      return await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: config.model },
        runningMode: 'IMAGE',
        numFaces: 1,
      })
    } catch (error) {
      console.error('Face landmarker loading error:', error)
      lastError = error
    }
  }
  throw lastError
}

const getFaceLandmarker = () => {
  if (!landmarkerPromise) {
    landmarkerPromise = createLandmarker()
    landmarkerPromise.catch(() => { landmarkerPromise = null })
  }
  return landmarkerPromise
}

const loadImage = (src) => new Promise((resolve, reject) => {
  const image = new Image()
  image.onload = () => resolve(image)
  image.onerror = reject
  image.src = src
})

// Find the topmost opaque pixel (real hair top) around the face center in an
// image that has a transparent background; returns a normalized y or null.
const findMaskTop = (image, centerX, halfWidthNormalized) => {
  const SCAN_HEIGHT = 512
  const scale = SCAN_HEIGHT / image.naturalHeight
  const width = Math.max(1, Math.round(image.naturalWidth * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = SCAN_HEIGHT
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0, width, SCAN_HEIGHT)

  const xStart = Math.max(0, Math.floor((centerX - halfWidthNormalized) * width))
  const xEnd = Math.min(width, Math.ceil((centerX + halfWidthNormalized) * width))
  if (xEnd <= xStart) return null

  const { data } = ctx.getImageData(xStart, 0, xEnd - xStart, SCAN_HEIGHT)
  const rowWidth = xEnd - xStart

  for (let y = 0; y < SCAN_HEIGHT; y++) {
    let opaqueCount = 0
    for (let x = 0; x < rowWidth; x++) {
      if (data[(y * rowWidth + x) * 4 + 3] > 128) {
        // Require a few opaque pixels so stray matting noise doesn't count
        if (++opaqueCount >= 3) return y / SCAN_HEIGHT
      }
    }
  }
  return null
}

// The face mesh has no "top of hair" landmark, only a forehead point. Measure
// the real crown by segmenting the photo (reusing the background-removal
// model already bundled in this app) and scanning for the topmost opaque
// pixel above the face. Falls back to a fixed-ratio estimate above the
// forehead landmark only if segmentation itself fails - that estimate is
// noticeably wrong on tightly-framed templates (e.g. India), so it's a last
// resort, not a normal code path.
const measureCrownY = async ({ photoSrc, maskedPhotoSrc, nose, forehead, chin, faceWidth }) => {
  const fallback = Math.max(0, forehead.y - (chin.y - forehead.y) * HAIR_ALLOWANCE)
  let objectUrl
  try {
    const maskedSrc = maskedPhotoSrc || (objectUrl = URL.createObjectURL(await removeBackground(photoSrc)))
    const maskedImage = await loadImage(maskedSrc)
    const maskTop = findMaskTop(maskedImage, nose.x, faceWidth * 0.75)
    return maskTop !== null ? maskTop : fallback
  } catch (error) {
    console.error('Auto align: hair-top segmentation failed, using estimate instead', error)
    return fallback
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl)
  }
}

// Compute the zoom and position for react-avatar-editor so the detected face
// fits the template's guide bars: crown of head centered in the top bar, chin
// centered in the bottom bar, nose tip on the vertical center line.
//
// react-avatar-editor (rotation 0) shows a crop rect of the image, in
// normalized image coordinates, centered at `position` with size
// (xScale/zoom, yScale/zoom) where xScale/yScale letterbox-fit the image
// aspect to the canvas aspect. MediaPipe landmarks are also normalized, so
// mapping between the two is direct.
export const autoAlignFace = async ({
  photoSrc,
  guides,
  editorDimensions,
  maskedPhotoSrc, // already-background-removed version of photoSrc, if on hand - avoids re-running the model
}) => {
  const topGuide = guides.find((g) => HEAD_TOP_GUIDES.includes(g.title))
  const bottomGuide = guides.find((g) => CHIN_GUIDES.includes(g.title))
  if (!topGuide || !bottomGuide) {
    const error = new Error('Template has no head guides')
    error.code = 'NO_GUIDES'
    throw error
  }

  const [landmarker, image] = await Promise.all([getFaceLandmarker(), loadImage(photoSrc)])
  const landmarks = landmarker.detect(image).faceLandmarks?.[0]
  if (!landmarks) {
    const error = new Error('No face detected')
    error.code = 'NO_FACE'
    throw error
  }

  const nose = landmarks[NOSE_TIP]
  const forehead = landmarks[FOREHEAD_TOP]
  const chin = landmarks[CHIN_BOTTOM]
  const faceWidth = Math.abs(landmarks[FACE_OVAL_RIGHT].x - landmarks[FACE_OVAL_LEFT].x)

  const crownY = await measureCrownY({ photoSrc, maskedPhotoSrc, nose, forehead, chin, faceWidth })

  // Guide coordinates are in 0.1mm units; dpi_ratio converts to editor pixels
  const toPx = editorDimensions.dpi_ratio
  const crownTargetY = (parseFloat(topGuide.start_y) + parseFloat(topGuide.height) / 2) * toPx
  const chinTargetY = (parseFloat(bottomGuide.start_y) + parseFloat(bottomGuide.height) / 2) * toPx

  const canvasHeight = editorDimensions.height
  const canvasAspect = editorDimensions.width / canvasHeight
  const imageAspect = image.naturalWidth / image.naturalHeight
  const yScale = Math.min(1, imageAspect / canvasAspect)

  // Zoom so the crown-to-chin span covers the distance between the two guides
  const targetSpan = chinTargetY - crownTargetY
  const faceSpan = chin.y - crownY
  const rawZoom = (yScale * targetSpan) / (faceSpan * canvasHeight)
  const zoom = Math.min(ABSOLUTE_MAX_ZOOM, Math.max(ABSOLUTE_MIN_ZOOM, rawZoom))

  // Position the crop rect so the crown and nose land on their targets
  const cropHeight = yScale / zoom
  const position = {
    x: nose.x, // center line is at canvas center, so the crop centers on the nose
    y: crownY - cropHeight * (crownTargetY / canvasHeight - 0.5),
  }

  console.debug('[AutoAlign]', {
    nose, forehead, chin, crownY, faceSpan,
    imageSize: { w: image.naturalWidth, h: image.naturalHeight },
    canvasSize: { w: editorDimensions.width, h: canvasHeight },
    yScale, crownTargetY, chinTargetY, targetSpan, rawZoom, zoom, position,
  })

  return { zoom, position }
}
