// script.js — robust client‑side meter reader with camera, upload, calibration, and live mode

let cvReady = false;
let streaming = false;
let liveMode = false;
let rafId = null;
let streamRef = null;

// UI handles
const statusEl = () => document.getElementById('status');
const startBtn = () => document.getElementById('startBtn');
const stopBtn = () => document.getElementById('stopBtn');
const captureBtn = () => document.getElementById('captureBtn');
const liveToggle = () => document.getElementById('liveToggle');
const fileInput = () => document.getElementById('fileInput');
const video = () => document.getElementById('videoInput');
const frameCanvas = () => document.getElementById('frameCanvas');
const overlayCanvas = () => document.getElementById('overlayCanvas');
const uploadCanvas = () => document.getElementById('uploadCanvas');
const readingValue = () => document.getElementById('readingValue');
const digitsRow = () => document.getElementById('digitsRow');
const debugToggle = () => document.getElementById('debugToggle');
const dialPatternSel = () => document.getElementById('dialPattern');
const zeroOffsetInput = () => document.getElementById('zeroOffset');
const minR = () => document.getElementById('minR');
const maxR = () => document.getElementById('maxR');
const dp = () => document.getElementById('dp');
const minDist = () => document.getElementById('minDist');
const param1 = () => document.getElementById('param1');
const param2 = () => document.getElementById('param2');
const calibrateBtn = () => document.getElementById('calibrateBtn');
const clearCalBtn = () => document.getElementById('clearCalBtn');
const snapshotBtn = () => document.getElementById('snapshotBtn');

// FIX: helper to obtain 2d context optimized for frequent readback
function get2dCtx(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true });
}

// Calibration storage
const CAL_KEY = 'au_meter_calibration_v1';
let manualCenters = null; // [{x,y,r} * 5]

function onOpenCvReady() {
  // FIX: ensure runtime is ready
  if (!cvReady) {
    cvReady = false;
    cv['onRuntimeInitialized'] = () => {
      cvReady = true;
      statusEl().innerText = 'OpenCV.js is ready.';
      wireUI();
      restoreCalibration();
    };
  }
}

function wireUI() {
  startBtn().addEventListener('click', startCamera);
  stopBtn().addEventListener('click', stopCamera);
  captureBtn().addEventListener('click', onCapture);
  liveToggle().addEventListener('change', e => { liveMode = e.target.checked; if (liveMode) loop(); else cancelLoop(); });
  fileInput().addEventListener('change', onFile);
  calibrateBtn().addEventListener('click', startManualCalibration);
  clearCalBtn().addEventListener('click', () => { manualCenters = null; localStorage.removeItem(CAL_KEY); toast('Calibration cleared'); });
  snapshotBtn().addEventListener('click', saveSnapshot);
}

async function startCamera() {
  if (!cvReady) return alert('OpenCV not ready yet');
  try {
    streamRef = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video().srcObject = streamRef;
    video().onloadedmetadata = () => {
      video().play();
      streaming = true;
      startBtn().disabled = true;
      stopBtn().disabled = false;
      captureBtn().disabled = false;
      // Size canvases to video
      resizeStage(video().videoWidth, video().videoHeight);
      statusEl().innerText = 'Camera started.';
    };
  } catch (e) {
    alert('Camera error: ' + e.message);
  }
}

function stopCamera() {
  if (streamRef) {
    streamRef.getTracks().forEach(t => t.stop());
    streamRef = null;
  }
  streaming = false;
  startBtn().disabled = false;
  stopBtn().disabled = true;
  captureBtn().disabled = true;
  cancelLoop();
  statusEl().innerText = 'Camera stopped.';
}

function resizeStage(w, h) {
  [frameCanvas(), overlayCanvas()].forEach(c => { c.width = w; c.height = h; });
}

function onCapture() {
  if (!streaming) return;
  const ctx = get2dCtx(frameCanvas()); // FIX: use helper with willReadFrequently
  ctx.drawImage(video(), 0, 0, frameCanvas().width, frameCanvas().height);
  const imgData = ctx.getImageData(0, 0, frameCanvas().width, frameCanvas().height); // FIX: read ImageData
  processAndRender(imgData);
}

function loop() {
  if (!liveMode || !streaming) return;
  const ctx = get2dCtx(frameCanvas()); // FIX: use helper with willReadFrequently
  ctx.drawImage(video(), 0, 0, frameCanvas().width, frameCanvas().height);
  const imgData = ctx.getImageData(0, 0, frameCanvas().width, frameCanvas().height); // FIX: read ImageData
  try { processAndRender(imgData); } finally { /* no mat to delete */ }
  rafId = requestAnimationFrame(loop);
}

function cancelLoop() { if (rafId) cancelAnimationFrame(rafId); rafId = null; }

function onFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const img = new Image();
  img.onload = () => {
    uploadCanvas().width = img.width; uploadCanvas().height = img.height;
    const ictx = get2dCtx(uploadCanvas()); // FIX: use helper
    ictx.drawImage(img, 0, 0);
    const imgData = ictx.getImageData(0, 0, uploadCanvas().width, uploadCanvas().height); // FIX: read ImageData
    resizeStage(img.width, img.height);
    const fctx = get2dCtx(frameCanvas()); fctx.drawImage(img,0,0);
    processAndRender(imgData);
  };
  img.src = URL.createObjectURL(file);
}

function processAndRender(imageData) {
  if (!cvReady) return; // FIX: wait for OpenCV runtime
  const dbg = debugToggle().checked ? get2dCtx(overlayCanvas()) : null; // FIX: use helper
  if (dbg) { dbg.clearRect(0,0,overlayCanvas().width, overlayCanvas().height); }

  let src = null, work = null, gray = null;
  try {
    src = cv.matFromImageData(imageData); // FIX: create Mat from ImageData
    work = new cv.Mat();
    if (src.type() === cv.CV_8UC4) {
      cv.cvtColor(src, work, cv.COLOR_RGBA2RGB); // FIX: 4C -> 3C
    } else if (src.type() === cv.CV_8UC3 || src.type() === cv.CV_8UC1) {
      src.copyTo(work);
    } else {
      src.convertTo(work, cv.CV_8UC3);
    }

    gray = new cv.Mat();
    if (work.type() === cv.CV_8UC3) cv.cvtColor(work, gray, cv.COLOR_RGB2GRAY); else work.copyTo(gray);

    const clahe = new cv.CLAHE(2.0, new cv.Size(8,8));
    clahe.apply(gray, gray); clahe.delete();
    const tmp = new cv.Mat();

    // FIX: validate bilateralFilter params
    let d = Number(7), sigmaColor = Number(50), sigmaSpace = Number(50);
    if (!Number.isFinite(d)) d = 9;
    if (!Number.isFinite(sigmaColor) || sigmaColor <= 0) sigmaColor = 75;
    if (!Number.isFinite(sigmaSpace)) sigmaSpace = 75;
    if (d <= 0 && sigmaSpace <= 0) sigmaSpace = 75;

    cv.bilateralFilter(gray, tmp, d, sigmaColor, sigmaSpace, cv.BORDER_DEFAULT);
    gray.delete();
    gray = tmp;

    let dials = manualCenters || detectDials(gray, dbg);
    if (!dials || dials.length !== 5) {
      updateUI(null, 'Could not detect 5 dials. Try manual calibration.');
      return;
    }

  // Sort left->right
  dials.sort((a,b)=>a.x-b.x);

  const pattern = dialPatternSel().value; // 'alt-cw', 'all-cw', 'all-ccw'
  const zeroOffset = deg2rad(parseFloat(zeroOffsetInput().value || '0'));

  const digits = [];
  const fractions = [];
  for (let i=0;i<5;i++) {
    const d = dials[i];
    const roi = cropCircle(gray, d);
    const angle = detectPointerAngle(roi, dbg, d);
    roi.delete();
    if (angle == null) { updateUI(null, `Pointer not found on dial ${i+1}`); return; }

    const cw = rotationForIndex(pattern, i); // true if clockwise numbering
    const {digit, frac} = angleToDigit(angle, cw, zeroOffset);
    digits.push(digit);
    fractions.push(frac);
  }

  // Borrow rule: if a dial is exactly on a number, look right dial
  const adj = digits.slice();
  for (let i=0;i<4;i++) {
    if (fractions[i] < 0.02 || fractions[i] > 0.98) { // near tick
      if (fractions[i+1] < 0.5) { // right dial has not passed zero
        adj[i] = (adj[i] + 9) % 10; // subtract 1 mod 10
      }
    }
  }

  const reading = adj.reduce((acc, d, idx) => acc + d * Math.pow(10, 4-idx), 0);
  updateUI({reading, digits: adj}, null);

    if (dbg) {
      dbg.lineWidth = 2; dbg.strokeStyle = 'rgba(80,200,120,0.9)';
      dials.forEach(d => { drawCircle(dbg, d.x, d.y, d.r); });
    }
  } catch (err) {
    console.warn('bilateralFilter failed:', err); // FIX: readable error
  } finally {
    if (src) src.delete();
    if (work) work.delete();
    if (gray) gray.delete();
  }
}

function detectDials(gray, dbg) {
  const circles = new cv.Mat();
  const dpVal = parseFloat(dp().value || '1.2');
  const minDistVal = parseInt(minDist().value || '50');
  const p1 = parseInt(param1().value || '80');
  const p2 = parseInt(param2().value || '32');
  const minRVal = parseInt(minR().value || '28');
  const maxRVal = parseInt(maxR().value || '62');

  cv.HoughCircles(gray, circles, cv.HOUGH_GRADIENT, dpVal, minDistVal, p1, p2, minRVal, maxRVal);
  const found = [];
  for (let i=0; i<circles.cols; i++) {
    const x = circles.data32F[i*3];
    const y = circles.data32F[i*3+1];
    const r = circles.data32F[i*3+2];
    found.push({x,y,r});
  }
  circles.delete();
  if (found.length < 5) return null;

  // Filter by horizontal alignment and radius consistency
  const medianY = median(found.map(c=>c.y));
  const rAvg = mean(found.map(c=>c.r));
  const aligned = found.filter(c => Math.abs(c.y - medianY) < rAvg * 0.35);
  const consistent = aligned.filter(c => Math.abs(c.r - rAvg) < rAvg * 0.25);
  const chosen = (consistent.length >= 5 ? consistent : aligned).sort((a,b)=>a.x-b.x).slice(0,5);

  if (dbg) { dbg.strokeStyle='rgba(255,180,0,0.9)'; dbg.lineWidth=2; chosen.forEach(c=>drawCircle(dbg,c.x,c.y,c.r)); }
  return chosen.length===5 ? chosen : null;
}

function cropCircle(srcGray, c) {
  const x1 = Math.max(0, Math.round(c.x - c.r));
  const y1 = Math.max(0, Math.round(c.y - c.r));
  const w = Math.min(srcGray.cols - x1, Math.round(c.r*2));
  const h = Math.min(srcGray.rows - y1, Math.round(c.r*2));
  const roi = srcGray.roi(new cv.Rect(x1, y1, w, h));
  // Mask annulus to focus on pointer, ignore center hub and outer border
  const mask = cv.Mat.zeros(roi.rows, roi.cols, cv.CV_8UC1);
  const center = new cv.Point(roi.cols/2, roi.rows/2);
  const outer = Math.min(roi.cols, roi.rows)/2 * 0.95;
  const inner = outer * 0.35;
  cv.circle(mask, center, outer, new cv.Scalar(255), -1);
  cv.circle(mask, center, inner, new cv.Scalar(0), -1);
  const masked = new cv.Mat();
  cv.bitwise_and(roi, roi, masked, mask);
  roi.delete(); mask.delete();
  // Enhance edges
  cv.GaussianBlur(masked, masked, new cv.Size(3,3), 0);
  return masked;
}

function detectPointerAngle(roi, dbg, dial) {
  const edges = new cv.Mat();
  cv.Canny(roi, edges, 60, 160);
  const lines = new cv.Mat();
  cv.HoughLines(edges, lines, 1, Math.PI/180, 55);
  edges.delete();
  if (lines.rows === 0) { lines.delete(); return null; }
  // Choose line with strongest vertical component (long radial) heuristic
  let bestTheta = null; let bestScore = -1;
  for (let i=0;i<lines.rows;i++) {
    const theta = lines.data32F[i*2+1];
    const score = Math.abs(Math.cos(theta)); // prefer near-vertical in ROI coords
    if (score > bestScore) { bestScore = score; bestTheta = theta; }
  }
  lines.delete();
  if (bestTheta == null) return null;
  const angleDeg = (90 - rad2deg(bestTheta) + 360) % 360; // 0 at top, clockwise

  if (dbg) {
    dbg.save();
    dbg.strokeStyle='rgba(80,200,120,0.9)'; dbg.lineWidth=2;
    drawCircle(dbg, dial.x, dial.y, dial.r);
    dbg.restore();
  }
  return deg(angleDeg);
}

function rotationForIndex(pattern, idx) {
  if (pattern === 'all-cw') return true;
  if (pattern === 'all-ccw') return false;
  return idx % 2 === 0; // alt-cw: 0,2,4 cw; 1,3 ccw
}

function angleToDigit(angleDeg, cw, zeroOffsetRad) {
  // Apply zero offset
  let a = angleDeg - rad2deg(zeroOffsetRad);
  if (a < 0) a += 360; a = a % 360;
  // If dial numbers advance CCW, mirror angle
  if (!cw) a = (360 - a) % 360;
  const pos = a / 36; // 10 digits per 360°
  const digit = Math.floor(pos) % 10;
  const frac = pos - digit; // fractional progress into next digit
  return { digit, frac };
}

function updateUI(result, err) {
  if (err) {
    readingValue().textContent = '—';
    digitsRow().innerHTML = '';
    statusEl().textContent = err;
    return;
  }
  if (!result) return;
  readingValue().textContent = result.reading.toString().padStart(5,'0');
  digitsRow().innerHTML = result.digits.map(d=>`<div class="digit">${d}</div>`).join('');
  statusEl().textContent = 'Ready';
}

// Manual calibration: user clicks five dial centers left->right
function startManualCalibration() {
  toast('Click the CENTER of each dial from LEFT to RIGHT (5 clicks).');
  const oc = overlayCanvas();
  const pts = [];
  const handler = (e) => {
    const rect = oc.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (oc.width / rect.width);
    const y = (e.clientY - rect.top) * (oc.height / rect.height);
    pts.push({x,y});
    drawPoint(get2dCtx(oc), x, y); // FIX: use helper context
    if (pts.length === 5) {
      oc.removeEventListener('click', handler);
      // Estimate radius as 90% of min distance between successive centers / 2
      let minDx = Infinity; for (let i=0;i<4;i++) minDx = Math.min(minDx, Math.hypot(pts[i+1].x-pts[i].x, pts[i+1].y-pts[i].y));
      const r = (minDx/2) * 0.9;
      manualCenters = pts.map(p=>({x:p.x,y:p.y,r:r}));
      localStorage.setItem(CAL_KEY, JSON.stringify(manualCenters));
      toast('Calibration saved. Capture or enable Live Read.');
    }
  };
  oc.addEventListener('click', handler);
}

function restoreCalibration() {
  const raw = localStorage.getItem(CAL_KEY);
  if (!raw) return;
  try { manualCenters = JSON.parse(raw); if (Array.isArray(manualCenters) && manualCenters.length===5) toast('Calibration restored'); else manualCenters=null; } catch { manualCenters=null; }
}

function saveSnapshot() {
  const a = document.createElement('a');
  a.download = `meter-${Date.now()}.png`;
  a.href = frameCanvas().toDataURL('image/png');
  a.click();
}

// Utils
function drawCircle(ctx, x,y,r){ ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.stroke(); }
function drawPoint(ctx, x,y){ ctx.fillStyle='rgba(79,124,255,.9)'; ctx.beginPath(); ctx.arc(x,y,6,0,Math.PI*2); ctx.fill(); }
function mean(arr){ return arr.reduce((a,b)=>a+b,0)/arr.length; }
function median(arr){ const s=[...arr].sort((a,b)=>a-b); const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; }
function deg(d){ return d; }
function deg2rad(d){ return d*Math.PI/180; }
function rad2deg(r){ return r*180/Math.PI; }
function toast(msg){ statusEl().textContent = msg; }
