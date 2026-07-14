import { getFaceLandmarker, loadImage } from './AutoAlign'

// MediaPipe Face Mesh landmark indices (same 478-point topology used in AutoAlign.js)
const FACE_OVAL_LEFT = 234
const FACE_OVAL_RIGHT = 454
const LEFT_EYE_OUTER = 33
const LEFT_EYE_INNER = 133
const LEFT_EYE_UPPER = 159
const LEFT_EYE_LOWER = 145
const RIGHT_EYE_OUTER = 263
const RIGHT_EYE_INNER = 362
const RIGHT_EYE_UPPER = 386
const RIGHT_EYE_LOWER = 374
const NOSE_TIP = 1
const FOREHEAD_REFERENCE = 8 // between the brows, reliably bare skin - used as a skin-tone reference

export const SEVERITY = { RELIABLE: 'reliable', HEURISTIC: 'heuristic' }

// These are starting points, not measured constants - there's no labeled test
// set to calibrate against here, so they're deliberately conservative (biased
// toward under-flagging) and are expected to be tuned from real photos during
// manual QA. See the plan's verification steps.
const THRESHOLDS = {
  EYES_CLOSED_BLINK: 0.6,
  SMILE: 0.4,
  JAW_OPEN: 0.3,
  ROLL_DEG_MAX: 8,
  YAW_RATIO_MAX: 1.6,
  MIN_FACE_WIDTH_RATIO: 0.2,
  // avg. gradient magnitude (0-255 scale) inside the eye-region band. A bare
  // eye (lashes/lid crease/iris contrast, no glasses) measured ~18-22 on a
  // real test photo - this is set well above that baseline with margin, but
  // has NOT been calibrated against an actual glasses photo (none available
  // while building this). Re-tune against real with/without-glasses photos
  // before trusting this check; it is intentionally the lowest-confidence
  // check in the set.
  GLASSES_EDGE_DENSITY: 35,
  EAR_COLOR_DISTANCE: 55, // RGB Euclidean distance vs. the skin-tone reference sample
}

const blendScore = (blendshapes, name) =>
  blendshapes.find((c) => c.categoryName === name)?.score ?? 0

// Renders the image once onto an offscreen canvas (capped resolution, for
// consistent/bounded-cost pixel sampling) and returns the pixel buffer plus
// the scale factor needed to map normalized landmark coords onto it.
const rasterize = (image) => {
  const MAX_DIM = 800
  const scale = Math.min(1, MAX_DIM / Math.max(image.naturalWidth, image.naturalHeight))
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(image, 0, 0, width, height)
  return { data: ctx.getImageData(0, 0, width, height).data, width, height }
}

const toPx = (landmark, width, height) => ({ x: landmark.x * width, y: landmark.y * height })

const grayAt = (pixels, width, height, x, y) => {
  x = Math.min(width - 1, Math.max(0, Math.round(x)))
  y = Math.min(height - 1, Math.max(0, Math.round(y)))
  const i = (y * width + x) * 4
  return 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]
}

const rgbAt = (pixels, width, height, x, y) => {
  x = Math.min(width - 1, Math.max(0, Math.round(x)))
  y = Math.min(height - 1, Math.max(0, Math.round(y)))
  const i = (y * width + x) * 4
  return { r: pixels[i], g: pixels[i + 1], b: pixels[i + 2], a: pixels[i + 3] }
}

// Glasses heuristic: glasses frames/lens rims create noticeably stronger local
// contrast than bare skin around the eyes. Average the gradient magnitude
// across a small band spanning each eye (outer corner to inner corner,
// padded above/below by the lid landmarks) and flag if it's unusually high.
// This will false-positive on some non-glasses cases (heavy eyeliner, deep
// eye shadows, low-quality/noisy photos) - it's intentionally surfaced as a
// low-confidence check, not a hard pass/fail.
const eyeRegionEdgeDensity = (raster, landmarks, outerIdx, innerIdx, upperIdx, lowerIdx) => {
  const { data, width, height } = raster
  const outer = toPx(landmarks[outerIdx], width, height)
  const inner = toPx(landmarks[innerIdx], width, height)
  const upper = toPx(landmarks[upperIdx], width, height)
  const lower = toPx(landmarks[lowerIdx], width, height)

  const padX = Math.abs(inner.x - outer.x) * 0.4
  const padY = Math.abs(lower.y - upper.y) * 0.6 + 2
  const x0 = Math.min(outer.x, inner.x) - padX
  const x1 = Math.max(outer.x, inner.x) + padX
  const y0 = Math.min(upper.y, lower.y) - padY
  const y1 = Math.max(upper.y, lower.y) + padY

  let total = 0
  let count = 0
  for (let y = Math.max(1, Math.round(y0)); y < Math.min(height - 1, Math.round(y1)); y++) {
    for (let x = Math.max(1, Math.round(x0)); x < Math.min(width - 1, Math.round(x1)); x++) {
      const gx = grayAt(data, width, height, x + 1, y) - grayAt(data, width, height, x - 1, y)
      const gy = grayAt(data, width, height, x, y + 1) - grayAt(data, width, height, x, y - 1)
      total += Math.sqrt(gx * gx + gy * gy)
      count++
    }
  }
  return count > 0 ? total / count : 0
}

const checkGlasses = (raster, landmarks) => {
  const left = eyeRegionEdgeDensity(raster, landmarks, LEFT_EYE_OUTER, LEFT_EYE_INNER, LEFT_EYE_UPPER, LEFT_EYE_LOWER)
  const right = eyeRegionEdgeDensity(raster, landmarks, RIGHT_EYE_OUTER, RIGHT_EYE_INNER, RIGHT_EYE_UPPER, RIGHT_EYE_LOWER)
  return Math.max(left, right) > THRESHOLDS.GLASSES_EDGE_DENSITY
}

// Ears heuristic: sample near where each ear sits (just outside the face
// oval, at eye height) and compare its color to a bare-skin reference patch
// (between the brows). A close color match suggests visible skin (ear or
// bare cheek); a large mismatch suggests something else is covering it
// (hair, a shadow, etc). If a background-removal mask is already available,
// skip points that fall on transparent background rather than guessing.
const checkEarsVisible = (raster, maskedRaster, landmarks) => {
  const { data, width, height } = raster
  const skin = toPx(landmarks[FOREHEAD_REFERENCE], width, height)
  const skinColor = rgbAt(data, width, height, skin.x, skin.y)

  const eyeLineY = (landmarks[LEFT_EYE_OUTER].y + landmarks[RIGHT_EYE_OUTER].y) / 2 * height
  const faceHalfWidth = Math.abs(landmarks[FACE_OVAL_RIGHT].x - landmarks[FACE_OVAL_LEFT].x) * width / 2
  const earPoints = [
    { x: landmarks[FACE_OVAL_LEFT].x * width - faceHalfWidth * 0.15, y: eyeLineY },
    { x: landmarks[FACE_OVAL_RIGHT].x * width + faceHalfWidth * 0.15, y: eyeLineY },
  ]

  let sawUncoveredCandidate = false
  let anyVisible = false
  for (const point of earPoints) {
    if (maskedRaster) {
      const scaleX = maskedRaster.width / width
      const scaleY = maskedRaster.height / height
      const maskSample = rgbAt(maskedRaster.data, maskedRaster.width, maskedRaster.height, point.x * scaleX, point.y * scaleY)
      if (maskSample.a < 128) continue // falls on background - inconclusive, don't guess
    }
    sawUncoveredCandidate = true
    const sample = rgbAt(data, width, height, point.x, point.y)
    const distance = Math.sqrt(
      (sample.r - skinColor.r) ** 2 + (sample.g - skinColor.g) ** 2 + (sample.b - skinColor.b) ** 2
    )
    if (distance < THRESHOLDS.EAR_COLOR_DISTANCE) anyVisible = true
  }

  if (!sawUncoveredCandidate) return false // couldn't sample anything conclusive - don't flag
  return !anyVisible
}

// Runs automated compliance checks against a single photo. Intended to be
// triggered on demand (the "Check My Photo" button), not automatically on
// upload, so it always reflects whatever photo/crop the user currently has
// loaded.
export const checkPhotoCompliance = async ({ photoSrc, maskedPhotoSrc }) => {
  const [landmarker, image] = await Promise.all([getFaceLandmarker(), loadImage(photoSrc)])
  const result = landmarker.detect(image)
  const faces = result.faceLandmarks || []
  const issues = []

  if (faces.length === 0) {
    issues.push({ id: 'noFace', severity: SEVERITY.RELIABLE, messageKey: 'checkNoFace' })
    return { issues, faceCount: 0 }
  }
  if (faces.length > 1) {
    issues.push({ id: 'multipleFaces', severity: SEVERITY.RELIABLE, messageKey: 'checkMultipleFaces' })
  }

  const landmarks = faces[0]
  const blendshapes = result.faceBlendshapes?.[0]?.categories || []

  const eyeBlink = (blendScore(blendshapes, 'eyeBlinkLeft') + blendScore(blendshapes, 'eyeBlinkRight')) / 2
  if (eyeBlink > THRESHOLDS.EYES_CLOSED_BLINK) {
    issues.push({ id: 'eyesClosed', severity: SEVERITY.RELIABLE, messageKey: 'checkEyesClosed' })
  }

  const smile = (blendScore(blendshapes, 'mouthSmileLeft') + blendScore(blendshapes, 'mouthSmileRight')) / 2
  const jawOpen = blendScore(blendshapes, 'jawOpen')
  if (smile > THRESHOLDS.SMILE || jawOpen > THRESHOLDS.JAW_OPEN) {
    issues.push({ id: 'notNeutral', severity: SEVERITY.RELIABLE, messageKey: 'checkNotNeutral' })
  }

  // Head tilt: computed directly from 2D landmark geometry (eye-line roll
  // angle + left/right nose-to-face-edge asymmetry for yaw) rather than the
  // face landmarker's transformation matrix - the matrix's row/column-major
  // packing isn't reliably documented, whereas the sign and magnitude of a
  // landmark-angle computation can be reasoned about directly.
  const leftEye = toPx(landmarks[LEFT_EYE_OUTER], image.naturalWidth, image.naturalHeight)
  const rightEye = toPx(landmarks[RIGHT_EYE_OUTER], image.naturalWidth, image.naturalHeight)
  const rollDeg = Math.abs(Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x) * 180 / Math.PI)

  const nose = landmarks[NOSE_TIP]
  const distLeft = Math.abs(nose.x - landmarks[FACE_OVAL_LEFT].x)
  const distRight = Math.abs(landmarks[FACE_OVAL_RIGHT].x - nose.x)
  const yawRatio = Math.max(distLeft, distRight) / Math.max(0.001, Math.min(distLeft, distRight))

  if (rollDeg > THRESHOLDS.ROLL_DEG_MAX || yawRatio > THRESHOLDS.YAW_RATIO_MAX) {
    issues.push({ id: 'headTilt', severity: SEVERITY.RELIABLE, messageKey: 'checkHeadTilt' })
  }

  const faceWidthRatio = Math.abs(landmarks[FACE_OVAL_RIGHT].x - landmarks[FACE_OVAL_LEFT].x)
  if (faceWidthRatio < THRESHOLDS.MIN_FACE_WIDTH_RATIO) {
    issues.push({ id: 'faceTooSmall', severity: SEVERITY.RELIABLE, messageKey: 'checkFaceTooSmall' })
  }

  const raster = rasterize(image)
  if (checkGlasses(raster, landmarks)) {
    issues.push({ id: 'glasses', severity: SEVERITY.HEURISTIC, messageKey: 'checkGlasses' })
  }

  const maskedImage = maskedPhotoSrc ? await loadImage(maskedPhotoSrc) : null
  const maskedRaster = maskedImage ? rasterize(maskedImage) : null
  if (checkEarsVisible(raster, maskedRaster, landmarks)) {
    issues.push({ id: 'earsCovered', severity: SEVERITY.HEURISTIC, messageKey: 'checkEarsCovered' })
  }

  return { issues, faceCount: faces.length }
}
