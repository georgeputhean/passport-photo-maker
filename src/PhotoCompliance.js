import { getFaceLandmarker, loadImage, measureCrownY } from './AutoAlign'

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
const FOREHEAD_TOP = 10
const CHIN_BOTTOM = 152

// Same fallback estimate AutoAlign.js uses when a true crown measurement
// (which needs background removal) isn't available - see measureCrownY.
const HAIR_ALLOWANCE = 0.25
const HEAD_TOP_GUIDES = ['Bar: Top', 'Top Head Area']
const CHIN_GUIDES = ['Bar: Bottom', 'Center Square: bottom']

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
  // Laplacian variance inside the face region. Lower = blurrier. Uncalibrated -
  // same caveat as above.
  BLUR_VARIANCE_MIN: 80,
  // Mean grayscale (0-255) of the face region considered acceptably exposed.
  EXPOSURE_MEAN_MIN: 60,
  EXPOSURE_MEAN_MAX: 200,
  // Standard deviation of the face region's grayscale - too low means flat/washed-out.
  CONTRAST_STD_MIN: 20,
  // RGB variance of sampled background pixels - higher means a patterned/uneven backdrop.
  BACKGROUND_VARIANCE_MAX: 900,
  // A source photo is flagged as low-resolution if, once cropped to the current
  // zoom, it would need to be upscaled beyond this factor to reach the
  // template's export pixel size.
  RESOLUTION_UPSCALE_TOLERANCE: 1.15,
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

// Bounding box around the face (forehead-to-chin, padded sideways to the face
// oval), used to restrict blur/exposure sampling to the subject rather than
// the whole frame - a sharp background behind a blurry face (or vice versa)
// would otherwise skew a whole-frame measurement.
const faceRegionBox = (landmarks, width, height) => {
  const left = toPx(landmarks[FACE_OVAL_LEFT], width, height)
  const right = toPx(landmarks[FACE_OVAL_RIGHT], width, height)
  const top = toPx(landmarks[FOREHEAD_TOP], width, height)
  const bottom = toPx(landmarks[CHIN_BOTTOM], width, height)
  const padX = Math.abs(right.x - left.x) * 0.15
  const padY = Math.abs(bottom.y - top.y) * 0.15
  return {
    x0: Math.min(left.x, right.x) - padX,
    x1: Math.max(left.x, right.x) + padX,
    y0: Math.min(top.y, bottom.y) - padY,
    y1: Math.max(top.y, bottom.y) + padY,
  }
}

// Blur heuristic: variance of the Laplacian (a standard focus-measure) inside
// the face region. A sharp, detailed face has high-variance edges; a blurry
// one is smoother and has lower variance.
const laplacianVariance = (raster, box) => {
  const { data, width, height } = raster
  const x0 = Math.max(1, Math.round(box.x0))
  const x1 = Math.min(width - 2, Math.round(box.x1))
  const y0 = Math.max(1, Math.round(box.y0))
  const y1 = Math.min(height - 2, Math.round(box.y1))
  let sum = 0
  let sumSq = 0
  let count = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const lap = -4 * grayAt(data, width, height, x, y)
        + grayAt(data, width, height, x - 1, y) + grayAt(data, width, height, x + 1, y)
        + grayAt(data, width, height, x, y - 1) + grayAt(data, width, height, x, y + 1)
      sum += lap
      sumSq += lap * lap
      count++
    }
  }
  if (count === 0) return null
  const mean = sum / count
  return sumSq / count - mean * mean
}

// Exposure/contrast: mean and standard deviation of grayscale values in the
// face region. Too dark/bright a mean, or too low a spread, both correspond
// to under/overexposed or flat, washed-out photos.
const exposureStats = (raster, box) => {
  const { data, width, height } = raster
  const x0 = Math.max(0, Math.round(box.x0))
  const x1 = Math.min(width, Math.round(box.x1))
  const y0 = Math.max(0, Math.round(box.y0))
  const y1 = Math.min(height, Math.round(box.y1))
  let sum = 0
  let sumSq = 0
  let count = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const g = grayAt(data, width, height, x, y)
      sum += g
      sumSq += g * g
      count++
    }
  }
  if (count === 0) return null
  const mean = sum / count
  const variance = Math.max(0, sumSq / count - mean * mean)
  return { mean, std: Math.sqrt(variance) }
}

// Background uniformity: sample color variance outside the face region. Only
// a real signal when a background-removal mask is on hand (Edit Mode) to
// distinguish background from foreground - without one (Compliance Mode,
// where background removal is off by default), this falls back to sampling
// raw-photo pixels outside the face box, which may include hair, shoulders,
// or clothing rather than true background. That fallback is reported with
// isReliable: false so the caller can surface it as a lower-confidence check.
const backgroundUniformity = (raster, maskedRaster, landmarks) => {
  const { width, height } = raster
  const faceBox = faceRegionBox(landmarks, width, height)
  const source = maskedRaster || raster
  const isReliable = Boolean(maskedRaster)
  const scaleX = source.width / width
  const scaleY = source.height / height
  const step = Math.max(1, Math.round(Math.max(source.width, source.height) / 60))

  const samples = []
  for (let y = 0; y < source.height; y += step) {
    for (let x = 0; x < source.width; x += step) {
      const rasterX = x / scaleX
      const rasterY = y / scaleY
      if (rasterX >= faceBox.x0 && rasterX <= faceBox.x1 && rasterY >= faceBox.y0 && rasterY <= faceBox.y1) continue
      const px = rgbAt(source.data, source.width, source.height, x, y)
      if (maskedRaster && px.a < 128) continue // masked-out (background) pixel - not what we're sampling
      samples.push(px)
    }
  }
  if (samples.length < 10) return null

  const meanR = samples.reduce((a, p) => a + p.r, 0) / samples.length
  const meanG = samples.reduce((a, p) => a + p.g, 0) / samples.length
  const meanB = samples.reduce((a, p) => a + p.b, 0) / samples.length
  const variance = samples.reduce((a, p) => a + (p.r - meanR) ** 2 + (p.g - meanG) ** 2 + (p.b - meanB) ** 2, 0) / samples.length
  return { variance, isReliable }
}

// Runs automated compliance checks against a single photo. Intended to be
// triggered on demand (the "Check My Photo" button), not automatically on
// upload, so it always reflects whatever photo/crop the user currently has
// loaded.
//
// template/exportPhoto/zoom/position/editorDimensions are all optional and
// only needed for the spec-relative checks (resolution, head position) - the
// face/expression/tilt checks below work from photoSrc alone, same as before.
export const checkPhotoCompliance = async ({ photoSrc, maskedPhotoSrc, template, exportPhoto, zoom, position, editorDimensions }) => {
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

  // Resolution and head-position-vs-spec both need to know what fraction of
  // the source photo the current crop actually uses - same yScale/cropHeight
  // math react-avatar-editor and AutoAlign.js use internally. Only run when
  // the caller supplied enough state to compute it (zoom/position/editorDimensions).
  if (zoom && position && editorDimensions?.width && editorDimensions?.height) {
    const imageAspect = image.naturalWidth / image.naturalHeight
    const canvasAspect = editorDimensions.width / editorDimensions.height
    const yScale = Math.min(1, imageAspect / canvasAspect)
    const cropHeight = yScale / zoom

    if (exportPhoto?.height) {
      const sourcePixelsUsedVertically = cropHeight * image.naturalHeight
      if (exportPhoto.height > sourcePixelsUsedVertically * THRESHOLDS.RESOLUTION_UPSCALE_TOLERANCE) {
        issues.push({ id: 'lowResolution', severity: SEVERITY.RELIABLE, messageKey: 'checkLowResolution' })
      }
    }

    const topGuide = template?.guide?.find((g) => HEAD_TOP_GUIDES.includes(g.title))
    const bottomGuide = template?.guide?.find((g) => CHIN_GUIDES.includes(g.title))
    if (topGuide && bottomGuide && editorDimensions.dpi_ratio) {
      const forehead = landmarks[FOREHEAD_TOP]
      const chin = landmarks[CHIN_BOTTOM]
      const faceWidth = faceWidthRatio

      // A true crown measurement needs background removal (see measureCrownY),
      // which Compliance Mode deliberately avoids - fall back to the same
      // anthropometric estimate AutoAlign.js uses when it can't segment, and
      // mark the check HEURISTIC rather than RELIABLE in that case.
      let crownY = forehead.y - (chin.y - forehead.y) * HAIR_ALLOWANCE
      let crownReliable = false
      if (maskedPhotoSrc) {
        try {
          crownY = await measureCrownY({ photoSrc, maskedPhotoSrc, nose: landmarks[NOSE_TIP], forehead, chin, faceWidth })
          crownReliable = true
        } catch (error) {
          console.error('Compliance check: crown measurement failed, using estimate', error)
        }
      }

      const canvasYOf = (imageY) => editorDimensions.height * ((imageY - position.y) / cropHeight + 0.5)
      const toGuideUnits = (canvasY) => canvasY / editorDimensions.dpi_ratio

      const crownGuideY = toGuideUnits(canvasYOf(crownY))
      const chinGuideY = toGuideUnits(canvasYOf(chin.y))
      const topBandLo = parseFloat(topGuide.start_y)
      const topBandHi = topBandLo + parseFloat(topGuide.height)
      const bottomBandLo = parseFloat(bottomGuide.start_y)
      const bottomBandHi = bottomBandLo + parseFloat(bottomGuide.height)
      // Generous tolerance beyond the band itself - these are aim points for
      // Auto Align, not a hard pixel-perfect boundary most applications enforce.
      const tolerance = parseFloat(topGuide.height)

      const outOfPosition =
        crownGuideY < topBandLo - tolerance || crownGuideY > topBandHi + tolerance ||
        chinGuideY < bottomBandLo - tolerance || chinGuideY > bottomBandHi + tolerance
      if (outOfPosition) {
        issues.push({ id: 'headPosition', severity: crownReliable ? SEVERITY.RELIABLE : SEVERITY.HEURISTIC, messageKey: 'checkHeadPosition' })
      }
    }
  }

  const raster = rasterize(image)
  const faceBox = faceRegionBox(landmarks, raster.width, raster.height)

  const variance = laplacianVariance(raster, faceBox)
  if (variance !== null && variance < THRESHOLDS.BLUR_VARIANCE_MIN) {
    issues.push({ id: 'blurry', severity: SEVERITY.HEURISTIC, messageKey: 'checkBlurry' })
  }

  const exposure = exposureStats(raster, faceBox)
  if (exposure) {
    if (exposure.mean < THRESHOLDS.EXPOSURE_MEAN_MIN || exposure.mean > THRESHOLDS.EXPOSURE_MEAN_MAX) {
      issues.push({ id: 'exposure', severity: SEVERITY.HEURISTIC, messageKey: 'checkExposure' })
    } else if (exposure.std < THRESHOLDS.CONTRAST_STD_MIN) {
      issues.push({ id: 'lowContrast', severity: SEVERITY.HEURISTIC, messageKey: 'checkLowContrast' })
    }
  }
  if (checkGlasses(raster, landmarks)) {
    issues.push({ id: 'glasses', severity: SEVERITY.HEURISTIC, messageKey: 'checkGlasses' })
  }

  const maskedImage = maskedPhotoSrc ? await loadImage(maskedPhotoSrc) : null
  const maskedRaster = maskedImage ? rasterize(maskedImage) : null
  if (checkEarsVisible(raster, maskedRaster, landmarks)) {
    issues.push({ id: 'earsCovered', severity: SEVERITY.HEURISTIC, messageKey: 'checkEarsCovered' })
  }

  const background = backgroundUniformity(raster, maskedRaster, landmarks)
  if (background && background.variance > THRESHOLDS.BACKGROUND_VARIANCE_MAX) {
    issues.push({
      id: 'backgroundNotUniform',
      severity: SEVERITY.HEURISTIC,
      messageKey: background.isReliable ? 'checkBackgroundNotUniform' : 'checkBackgroundNotUniformLowConfidence',
    })
  }

  return { issues, faceCount: faces.length }
}
