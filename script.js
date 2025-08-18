/**
 * Digital Darkroom Simulator
 * A web-based application that simulates darkroom printing process
 */

// --- Simple IndexedDB helpers for storing handles ---
const DB_NAME = 'darkroom-db';
const STORE_NAME = 'kv';

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbSet(key, value) {
  return idbOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function idbGet(key) {
  return idbOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

// --- D–logE helpers ---

function log10(x) { return Math.log(x) / Math.LN10; }

// A smooth toe/shoulder curve in logE space.
// D = Dmin + (Dmax - Dmin) / (1 + exp(-k * (logE - E0)))
// - k controls slope (≈ contrast)
// - E0 is the "midtone" log exposure
function densityFromLogE(logE, Dmin, Dmax, k, E0) {
  const span = Dmax - Dmin;
  const D = Dmin + span / (1 + Math.exp(-k * (logE - E0)));
  return Math.max(Dmin, Math.min(D, Dmax));
}

// Compute E0 (midtone) for a grade, incorporating the paper's base time and speed-matching.
// For grades 00–3½: speedShiftStops = 0 (matched).
// For higher grades: shift right in logE by +stops (needs more time).
function midtoneLogEForGrade(paper, grade) {
  const p = paper.gradeParams[grade];
  const baseE = paper.baseExposure;              // arbitrary “exposure units”
  const Eshift = Math.pow(2, p.speedShiftStops); // stops → multiplier
  const Emidtone = baseE * Eshift;
  return log10(Emidtone);
}

// Convert one exposure (time, grade, pixel transmittance, local dodge) to density.
// We compute density per exposure then add the EXCESS density above Dmin across exposures.
// This approximates mixed-grade printing where filters differ.
function densityFromOneExposure(paper, timeSec, grade, trans, localMask) {
  const p = paper.gradeParams[grade];
  // Exposure at pixel BEFORE curve (E ∝ time × trans), with dodge on exposure:
  // - dodge: localMask in (0..1) reduces exposure by (1 - mask)
  const maskMul = localMask > 0 ? (1 - localMask) : 1;
  const E = Math.max(1e-6, timeSec * trans * maskMul); // arbitrary units
  const logE = log10(E);
  const E0 = midtoneLogEForGrade(paper, grade);
  return densityFromLogE(logE, paper.Dmin, paper.Dmax, p.k, E0);
}

// Main application object
const DarkroomSimulator = {
  // State variables
  originalImage: null,
  negativeImage: null,
  paperType: 'ilford-multigrade',
  exposures: [],
  resultImage: null,
  histogramData: null,
  selectedExposureId: null, // Track the currently selected exposure
  negativeImageEl: null,
  currentProjectId: null, // Track the current project ID for auto-save

  // Mask tool variables
  maskCanvas: null,
  maskCtx: null,
  maskData: null,
  isMaskToolActive: false,
  activeTool: 'dodge', // 'dodge' or 'erase'
  brushSize: 20, // percentage of image size
  brushFeather: 10, // percentage of brush size
  isDrawing: false,
  lastX: 0,
  lastY: 0,
  resizeTimeout: null,
  paintingHandlersAttached: false,
  brushFlow: 0.03,  // lower = gentler build-up

  // --- FAST PATH state ---
  workCanvas: null,
  workCtx: null,
  resultCanvasEl: null,  // <canvas id="result-canvas"> (preferred)
  resultImageEl: null,   // <img id="result-image"> (fallback if canvas missing)

  trans: null,           // Float32Array per pixel (0..1)
  logTrans: null,        // Float32Array per pixel (log10(trans))

  sigmoidLUT: null,      // { lut, lo, hi, step }
  _processTimer: null,   // debounce handle

  // Paper characteristics (response curves)
  // These are simplified approximations of real paper response curves
  papers: {
    'ilford-multigrade': {
      name: 'Ilford Multigrade',
      description: 'Variable contrast paper with good tonal range',
      baseExposure: 16,     // seconds for a "normal" midtone
      Dmin: 0.06,           // paper white (base + fog)
      Dmax: 2.05,           // deep black
      // Per-grade curve + speed hints (0=00 ... 11=5)
      gradeParams: [
        { k: 2.2, speedShiftStops: 0.0 }, // 00
        { k: 2.5, speedShiftStops: 0.0 }, // 0
        { k: 2.9, speedShiftStops: 0.0 }, // 0.5
        { k: 3.3, speedShiftStops: 0.0 }, // 1
        { k: 3.7, speedShiftStops: 0.0 }, // 1.5
        { k: 4.2, speedShiftStops: 0.0 }, // 2
        { k: 4.8, speedShiftStops: 0.0 }, // 2.5
        { k: 5.5, speedShiftStops: 0.0 }, // 3
        { k: 6.3, speedShiftStops: 0.2 }, // 3.5  (start needing more time)
        { k: 7.3, speedShiftStops: 0.4 }, // 4
        { k: 8.5, speedShiftStops: 0.6 }, // 4.5
        { k: 10.0, speedShiftStops: 0.8 } // 5
      ],
      // Slightly cool/neutral tone
      colorTone: {
        highlights: { r: 0.97, g: 0.99, b: 1.00 },
        midtones:   { r: 0.96, g: 0.98, b: 1.00 },
        shadows:    { r: 0.94, g: 0.97, b: 1.00 }
      }
    },

    'kodak-polymax': {
      name: 'Kodak Polymax',
      description: 'Resin-coated paper with warm tones',
      baseExposure: 16,
      Dmin: 0.06,
      Dmax: 2.10,
      gradeParams: [
        { k: 2.3, speedShiftStops: 0.0 }, { k: 2.6, speedShiftStops: 0.0 },
        { k: 3.0, speedShiftStops: 0.0 }, { k: 3.4, speedShiftStops: 0.0 },
        { k: 3.9, speedShiftStops: 0.0 }, { k: 4.5, speedShiftStops: 0.0 },
        { k: 5.2, speedShiftStops: 0.0 }, { k: 6.0, speedShiftStops: 0.2 },
        { k: 7.0, speedShiftStops: 0.4 }, { k: 8.2, speedShiftStops: 0.6 },
        { k: 9.6, speedShiftStops: 0.8 }, { k: 11.0, speedShiftStops: 1.0 }
      ],
      colorTone: {
        highlights: { r: 1.00, g: 0.98, b: 0.92 },
        midtones:   { r: 1.00, g: 0.96, b: 0.88 },
        shadows:    { r: 1.00, g: 0.94, b: 0.82 }
      }
    },

    'foma-variant': {
      name: 'Foma Variant',
      description: 'Fiber-based paper with classic look',
      baseExposure: 16,
      Dmin: 0.06,
      Dmax: 1.95,
      gradeParams: [
        { k: 2.0, speedShiftStops: 0.0 }, { k: 2.3, speedShiftStops: 0.0 },
        { k: 2.7, speedShiftStops: 0.0 }, { k: 3.1, speedShiftStops: 0.0 },
        { k: 3.6, speedShiftStops: 0.0 }, { k: 4.1, speedShiftStops: 0.0 },
        { k: 4.7, speedShiftStops: 0.0 }, { k: 5.4, speedShiftStops: 0.2 },
        { k: 6.2, speedShiftStops: 0.4 }, { k: 7.1, speedShiftStops: 0.6 },
        { k: 8.2, speedShiftStops: 0.8 }, { k: 9.4, speedShiftStops: 1.0 }
      ],
      colorTone: {
        highlights: { r: 1.00, g: 0.97, b: 0.94 },
        midtones:   { r: 1.00, g: 0.95, b: 0.90 },
        shadows:    { r: 1.00, g: 0.92, b: 0.85 }
      }
    },

    'oriental-seagull': {
      name: 'Oriental Seagull',
      description: 'High-quality paper with deep blacks',
      baseExposure: 16,
      Dmin: 0.06,
      Dmax: 2.20,
      gradeParams: [
        { k: 2.4, speedShiftStops: 0.0 }, { k: 2.8, speedShiftStops: 0.0 },
        { k: 3.2, speedShiftStops: 0.0 }, { k: 3.7, speedShiftStops: 0.0 },
        { k: 4.2, speedShiftStops: 0.0 }, { k: 4.8, speedShiftStops: 0.0 },
        { k: 5.5, speedShiftStops: 0.0 }, { k: 6.3, speedShiftStops: 0.2 },
        { k: 7.2, speedShiftStops: 0.4 }, { k: 8.3, speedShiftStops: 0.6 },
        { k: 9.6, speedShiftStops: 0.8 }, { k: 11.0, speedShiftStops: 1.0 }
      ],
      colorTone: {
        highlights: { r: 0.96, g: 0.98, b: 1.00 },
        midtones:   { r: 0.94, g: 0.97, b: 1.00 },
        shadows:    { r: 0.90, g: 0.95, b: 1.00 }
      }
    }
  },

  // Initialize the application
  init: function () {
    this.resultCanvasEl = document.getElementById('result-canvas') || null;
    this.resultImageEl  = document.getElementById('result-image')  || null;

    if (!this.workCanvas) {
      this.workCanvas = document.createElement('canvas');
      this.workCtx = this.workCanvas.getContext('2d', { willReadFrequently: true });
    }

    // Build sigmoid LUT once
    if (!this.sigmoidLUT) {
      const N = 2048, lo = -12, hi = 12;
      const step = (hi - lo) / (N - 1);
      const lut = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const x = lo + i * step;
        lut[i] = 1 / (1 + Math.exp(-x));
      }
      this.sigmoidLUT = { lut, lo, hi, step };
    }

    this.negativeImageEl = document.getElementById('negative-image');
    this.setupEventListeners();
    this.updatePaperInfo();
    if (this.exposures.length === 0) this.addExposure();

    // Check for URL parameters
    this.checkUrlParameters();
  },

  // Set up event listeners
  setupEventListeners: function() {

    // Image upload
    const imageUploadEl = document.getElementById('image-upload');
    if (imageUploadEl) {
      imageUploadEl.addEventListener('change', this.handleImageUpload.bind(this));
    }

    // Paper selection
    document.getElementById('paper-type').addEventListener('change', (e) => {
      this.paperType = e.target.value;
      this.updatePaperInfo();
      // Automatically process image when paper type changes
      if (this.negativeImage) {
        this.requestProcess();
      }
    });

    // Add exposure button
    document.getElementById('add-exposure').addEventListener('click', this.addExposure.bind(this));

    // Process image is now automatic when exposures or paper change

    // Mask tool buttons
    document.getElementById('dodge-tool').addEventListener('click', () => {
      this.activeTool = 'dodge';
      this.updateToolButtons();
    });


    document.getElementById('erase-tool').addEventListener('click', () => {
      this.activeTool = 'erase';
      this.updateToolButtons();
    });

    document.getElementById('clear-mask').addEventListener('click', () => {
      this.clearMask();
      this.requestProcess();
    });

    // Brush size and feather controls
    document.getElementById('brush-size').addEventListener('input', (e) => {
      this.brushSize = parseInt(e.target.value);
      const brushSizeValueEl = document.getElementById('brush-size-value');
      if (brushSizeValueEl) {
        brushSizeValueEl.textContent = this.brushSize;
      }

      // Update preview circles when brush size changes
      if (this.maskCanvas && !this.isDrawing) {
        const imgRect = this.negativeImageEl.getBoundingClientRect();
        const scaleX = this.maskCanvas.width / imgRect.width;
        const scaleY = this.maskCanvas.height / imgRect.height;

        // Get current mouse position relative to the image
        const rect = this.maskCanvas.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          // Use last known mouse position
          const x = this.lastX || (this.maskCanvas.width / 2);
          const y = this.lastY || (this.maskCanvas.height / 2);
          this.drawPreviewCircles(x, y, scaleX, scaleY);
        }
      }
    });

    document.getElementById('brush-feather').addEventListener('input', (e) => {
      this.brushFeather = parseInt(e.target.value);
      const brushFeatherValueEl = document.getElementById('brush-feather-value');
      if (brushFeatherValueEl) {
        brushFeatherValueEl.textContent = this.brushFeather;
      }

      // Update preview circles when feather changes
      if (this.maskCanvas && !this.isDrawing) {
        const imgRect = this.negativeImageEl.getBoundingClientRect();
        const scaleX = this.maskCanvas.width / imgRect.width;
        const scaleY = this.maskCanvas.height / imgRect.height;

        // Get current mouse position relative to the image
        const rect = this.maskCanvas.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          // Use last known mouse position
          const x = this.lastX || (this.maskCanvas.width / 2);
          const y = this.lastY || (this.maskCanvas.height / 2);
          this.drawPreviewCircles(x, y, scaleX, scaleY);
        }
      }
    });

    // Initialize mask canvas when the DISPLAYED img loads
    this.negativeImageEl.addEventListener('load', () => {
      // Defer to ensure <img> has non-zero layout box
      requestAnimationFrame(() => {
        this.initMaskCanvas();
        this.positionMaskCanvasToImage();
        this.updateMaskCanvas();
        this.updateAllDodgeMaskPreviews();
      });
    });

    // Reinitialize mask canvas when window is resized
    window.addEventListener('resize', () => {
      if (this.negativeImage && this.maskCanvas) {
        if (this.resizeTimeout) clearTimeout(this.resizeTimeout);
        this.resizeTimeout = setTimeout(() => {
          this.initMaskCanvas();
          this.positionMaskCanvasToImage();

          // Rehydrate the on-screen canvas from the selected exposure’s saved mask
          this.updateMaskCanvas();

          // Refresh the little previews too
          this.updateAllDodgeMaskPreviews();

          // Re-render the result
          this.requestProcess();
        }, 200);
      }
    });

  },

  // Initialize the mask canvas
  initMaskCanvas: function () {
    if (!this.negativeImage) return;

    this.maskCanvas = document.getElementById('mask-canvas');
    this.maskCtx    = this.maskCanvas.getContext('2d', { willReadFrequently: true });

    // Create preview canvas if it doesn't exist
    if (!this.previewCanvas) {
      this.previewCanvas = document.createElement('canvas');
      this.previewCtx = this.previewCanvas.getContext('2d', { willReadFrequently: true });
      this.previewCanvas.id = 'preview-canvas';
      this.previewCanvas.style.position = 'absolute';
      this.previewCanvas.style.pointerEvents = 'none';
      this.previewCanvas.style.zIndex = '3'; // Above mask canvas
    }

    const container = document.querySelector('.negative-container');
    if (this.maskCanvas.parentElement !== container) container.appendChild(this.maskCanvas);
    if (this.previewCanvas.parentElement !== container) container.appendChild(this.previewCanvas);

    // Internal pixel size must match the image’s natural pixels
    const w = this.negativeImage.naturalWidth;
    const h = this.negativeImage.naturalHeight;
    if (this.maskCanvas.width !== w || this.maskCanvas.height !== h) {
      this.maskCanvas.width  = w;
      this.maskCanvas.height = h;
      this.maskCtx.clearRect(0, 0, w, h);
      if (this.selectedExposureId) this.updateMaskCanvas();
    }

    // Set preview canvas to same dimensions
    if (this.previewCanvas.width !== w || this.previewCanvas.height !== h) {
      this.previewCanvas.width = w;
      this.previewCanvas.height = h;
      this.previewCtx.clearRect(0, 0, w, h);
    }

    // (CSS handles size/position: inset:0 + width/height:100%)

    // Attach painting handlers once
    this.positionMaskCanvasToImage();
    this.setupMaskPainting();

    if (!this.maskData || this.maskData.length !== w * h) {
      this.maskData = new Float32Array(w * h);
    }

    this.positionMaskCanvasToImage();
  },

  // Set up mouse events for mask painting
  setupMaskPainting: function() {
    if (!this.maskCanvas) return;
    if (this.paintingHandlersAttached) return;

    this.paintingHandlersAttached = true;

    const negativeContainer = document.querySelector('.negative-container');
    const self = this;

    // Make the mask canvas receive pointer events
    this.maskCanvas.style.pointerEvents = 'auto';

    // Mouse down event
    this.maskCanvas.addEventListener('mousedown', (e) => {
      const imgEl  = document.getElementById('negative-image');   // <—
      const imgRect = imgEl.getBoundingClientRect();              // <—
      if (
        imgRect.width === 0 || imgRect.height === 0 ||
        e.clientX < imgRect.left || e.clientX > imgRect.right ||
        e.clientY < imgRect.top  || e.clientY > imgRect.bottom
      ) return;

      this.isDrawing = true;

      const scaleX = this.maskCanvas.width  / imgRect.width;
      const scaleY = this.maskCanvas.height / imgRect.height;
      this.lastX = (e.clientX - imgRect.left) * scaleX;
      this.lastY = (e.clientY - imgRect.top)  * scaleY;

      this.draw(e);
    });

    // Mouse move event
    this.maskCanvas.addEventListener('mousemove', (e) => {
      const imgRect = self.negativeImageEl.getBoundingClientRect();
      const scaleX = self.maskCanvas.width  / imgRect.width;
      const scaleY = self.maskCanvas.height / imgRect.height;

      const x = (e.clientX - imgRect.left) * scaleX;
      const y = (e.clientY - imgRect.top)  * scaleY;

      // Draw preview circles when not drawing
      if (!self.isDrawing) {
        self.drawPreviewCircles(x, y, scaleX, scaleY);
        return;
      }

      // Calculate radius based on percentage of image's smallest dimension
      const imageDimension = Math.min(self.maskCanvas.width, self.maskCanvas.height);
      const R = (self.brushSize / 100) * imageDimension;
      const dx = x - self.lastX, dy = y - self.lastY;
      const dist = Math.hypot(dx, dy);
      const step = R * 0.25; // 25% brush radius spacing

      for (let t = 0; t <= dist; t += step) {
        const sx = self.lastX + (dx * (t / dist || 0));
        const sy = self.lastY + (dy * (t / dist || 0));
        self._stamp(sx, sy, R);
      }
    });

    // Mouse up event
    window.addEventListener('mouseup', function(e) {
      if (self.isDrawing) {
        self.isDrawing = false;
        self.updateMaskData();
        self.requestProcess();

        // Show preview circles again after drawing is complete
        if (self.maskCanvas.contains(e.target) || self.negativeImageEl.contains(e.target)) {
          const imgRect = self.negativeImageEl.getBoundingClientRect();
          const scaleX = self.maskCanvas.width / imgRect.width;
          const scaleY = self.maskCanvas.height / imgRect.height;
          const x = (e.clientX - imgRect.left) * scaleX;
          const y = (e.clientY - imgRect.top) * scaleY;

          // Use setTimeout to ensure the mask is updated before drawing the preview
          setTimeout(() => {
            self.drawPreviewCircles(x, y, scaleX, scaleY);
          }, 0);
        }
      }
    });

    // Mouse leave event
    this.maskCanvas.addEventListener('mouseleave', function() {
      if (self.isDrawing) {
        self.isDrawing = false;
        self.updateMaskData();
        self.requestProcess();
      }
      // Clear preview circles when mouse leaves canvas
      self.clearPreviewCircles();
    });

    // Mouse wheel event for brush size
    this.maskCanvas.addEventListener('wheel', function(e) {
      e.preventDefault();
      if (e.shiftKey) {
        // Adjust feather with Shift + wheel (percentage of brush size)
        self.brushFeather = Math.max(0, Math.min(100, self.brushFeather - Math.sign(e.deltaY) * 5));
        document.getElementById('brush-feather').value = self.brushFeather;
        const brushFeatherValueEl = document.getElementById('brush-feather-value');
        if (brushFeatherValueEl) {
          brushFeatherValueEl.textContent = self.brushFeather;
        }
      } else {
        // Adjust size with wheel (percentage of image size)
        self.brushSize = Math.max(1, Math.min(100, self.brushSize - Math.sign(e.deltaY) * 5));
        document.getElementById('brush-size').value = self.brushSize;
        const brushSizeValueEl = document.getElementById('brush-size-value');
        if (brushSizeValueEl) {
          brushSizeValueEl.textContent = self.brushSize;
        }
      }

      // Update preview circles when brush size or feather changes
      if (!self.isDrawing) {
        const imgRect = self.negativeImageEl.getBoundingClientRect();
        const scaleX = self.maskCanvas.width / imgRect.width;
        const scaleY = self.maskCanvas.height / imgRect.height;

        // Calculate mouse position relative to the image
        const x = (e.clientX - imgRect.left) * scaleX;
        const y = (e.clientY - imgRect.top) * scaleY;

        // Store the current position for future reference
        self.lastX = x;
        self.lastY = y;

        // Force immediate update of preview
        setTimeout(() => {
          self.drawPreviewCircles(x, y, scaleX, scaleY);
        }, 0);
      }
    });
  },

  // Draw preview circles showing brush size and feather
  drawPreviewCircles: function(x, y, scaleX, scaleY) {
    if (!this.previewCtx) return;

    // Clear previous preview
    this.clearPreviewCircles();

    // Only draw the preview circles if a mask tool (dodge or erase) is active
    if (!this.isMaskToolActive) return;

    // Calculate scaled brush size and feather
    // brushSize is now a percentage of the image's smallest dimension
    const imageDimension = Math.min(this.maskCanvas.width, this.maskCanvas.height);
    const outerRadius = (this.brushSize / 100) * imageDimension;
    const innerRadius = outerRadius * (1 - this.brushFeather / 100);

    // Draw outer circle (full brush size including feather)
    this.previewCtx.save();

    // Draw outer circle with fill for better visibility
    this.previewCtx.fillStyle = 'rgba(255, 50, 50, 0.15)';
    this.previewCtx.beginPath();
    this.previewCtx.arc(x, y, outerRadius, 0, Math.PI * 2);
    this.previewCtx.fill();

    // Stroke for outer circle - bright red with high contrast
    this.previewCtx.strokeStyle = '#FF0000';
    this.previewCtx.lineWidth = 3;
    this.previewCtx.beginPath();
    this.previewCtx.arc(x, y, outerRadius, 0, Math.PI * 2);
    this.previewCtx.stroke();

    // Draw inner circle (solid part without feather)
    this.previewCtx.strokeStyle = '#FF0000';
    this.previewCtx.lineWidth = 3;
    this.previewCtx.beginPath();
    this.previewCtx.arc(x, y, innerRadius, 0, Math.PI * 2);
    this.previewCtx.stroke();

    this.previewCtx.restore();
  },

  // Clear preview circles
  clearPreviewCircles: function() {
    if (!this.previewCtx || !this.previewCanvas) return;

    // Simply clear the preview canvas
    this.previewCtx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);
  },

  // factor out the stamping logic
  _stamp(x, y, R) {
    if (!this.maskCtx) return;

    const tInner = Math.max(0, Math.min(1, 1 - this.brushFeather / 100));
    const tMid   = Math.max(tInner, Math.min(1, 1 - (this.brushFeather * 0.5) / 100));

    // blend mode by tool
    this.maskCtx.globalCompositeOperation =
      (this.activeTool === 'erase') ? 'destination-out' : 'source-over';

    // **flow**: lower alpha per stamp so build-up is gradual
    this.maskCtx.globalAlpha = (this.activeTool === 'erase') ? 1 : this.brushFlow;

    const g = this.maskCtx.createRadialGradient(x, y, 0, x, y, R);
    if (this.activeTool === 'erase') {
      // only alpha matters for destination-out
      g.addColorStop(0,      'rgba(0,0,0,1)');
      g.addColorStop(tInner, 'rgba(0,0,0,1)');
      g.addColorStop(tMid,   'rgba(0,0,0,0.6)');
      g.addColorStop(1,      'rgba(0,0,0,0)');
    } else {
      g.addColorStop(0,      'rgba(255,0,0,1)');
      g.addColorStop(tInner, 'rgba(255,0,0,1)');
      g.addColorStop(tMid,   'rgba(255,0,0,0.6)');
      g.addColorStop(1,      'rgba(255,0,0,0)');
    }

    this.maskCtx.fillStyle = g;
    this.maskCtx.beginPath();
    this.maskCtx.arc(x, y, R, 0, Math.PI * 2);
    this.maskCtx.fill();

    // reset
    this.maskCtx.globalAlpha = 1;
    this.maskCtx.globalCompositeOperation = 'source-over';
  },

  draw: function(e) {
    if (!this.maskCtx) return;

    const imgEl  = document.getElementById('negative-image');
    const imgRect = imgEl.getBoundingClientRect();
    if (
      imgRect.width === 0 || imgRect.height === 0 ||
      e.clientX < imgRect.left || e.clientX > imgRect.right ||
      e.clientY < imgRect.top  || e.clientY > imgRect.bottom
    ) return;

    const scaleX = this.maskCanvas.width  / imgRect.width;
    const scaleY = this.maskCanvas.height / imgRect.height;

    const x = (e.clientX - imgRect.left) * scaleX;
    const y = (e.clientY - imgRect.top)  * scaleY;

    // Calculate radius based on percentage of image's smallest dimension
    const imageDimension = Math.min(this.maskCanvas.width, this.maskCanvas.height);
    const R = (this.brushSize / 100) * imageDimension;
    const tInner = Math.max(0, Math.min(1, 1 - this.brushFeather / 100));
    const tMid   = Math.max(tInner, Math.min(1, 1 - (this.brushFeather * 0.5) / 100));

    // <-- set blend mode by tool
    this.maskCtx.globalCompositeOperation =
      (this.activeTool === 'erase') ? 'destination-out' : 'source-over';

    const g = this.maskCtx.createRadialGradient(x, y, 0, x, y, R);
    if (this.activeTool === 'dodge') {
      g.addColorStop(0,      'rgba(255,0,0,1)');
      g.addColorStop(tInner, 'rgba(255,0,0,1)');
      g.addColorStop(tMid,   'rgba(255,0,0,0.6)');
      g.addColorStop(1,      'rgba(255,0,0,0)');
    } else {
      // color is irrelevant for destination-out; only alpha matters
      g.addColorStop(0,      'rgba(0,0,0,1)');
      g.addColorStop(tInner, 'rgba(0,0,0,1)');
      g.addColorStop(tMid,   'rgba(0,0,0,0.6)');
      g.addColorStop(1,      'rgba(0,0,0,0)');
    }

    this.maskCtx.fillStyle = g;
    this.maskCtx.beginPath();
    this.maskCtx.arc(x, y, R, 0, Math.PI * 2);
    this.maskCtx.fill();

    // reset for safety
    this.maskCtx.globalCompositeOperation = 'source-over';
  },


  // match canvas CSS box to the displayed <img> box
  positionMaskCanvasToImage: function () {
    if (!this.negativeImageEl || !this.maskCanvas) return;

    const imgRect = this.negativeImageEl.getBoundingClientRect();
    // If the image hasn't laid out yet, try again next frame.
    if (imgRect.width < 2 || imgRect.height < 2) {
      requestAnimationFrame(() => this.positionMaskCanvasToImage());
      return;
    }

    const contRect = document.querySelector('.negative-container').getBoundingClientRect();
    const left = imgRect.left - contRect.left;
    const top  = imgRect.top  - contRect.top;

    // Position mask canvas
    if (this.maskCanvas) {
      const s = this.maskCanvas.style;
      s.position = 'absolute';
      s.left = `${left}px`;
      s.top = `${top}px`;
      s.width = `${imgRect.width}px`;
      s.height = `${imgRect.height}px`;
      s.zIndex = 2;
      s.pointerEvents = 'auto';
    }

    // Position preview canvas
    if (this.previewCanvas) {
      const s = this.previewCanvas.style;
      s.position = 'absolute';
      s.left = `${left}px`;
      s.top = `${top}px`;
      s.width = `${imgRect.width}px`;
      s.height = `${imgRect.height}px`;
      s.zIndex = 3;
      s.pointerEvents = 'none';
    }
  },

  updateMaskData: function() {
    if (!this.maskCtx || !this.negativeImage) return;
    if (!this.selectedExposureId) return;

    const exp = this.exposures.find(x => x.id === this.selectedExposureId);
    if (!exp) return;

    const W = this.maskCanvas.width, H = this.maskCanvas.height;

    // Check if canvas dimensions are valid
    if (W <= 0 || H <= 0) {
      console.warn('Invalid mask canvas dimensions:', W, 'x', H);
      return;
    }

    if (!exp.mask || exp.mask.length !== W * H) {
      exp.mask = new Float32Array(W * H);
    }

    const imageData = this.maskCtx.getImageData(0, 0, W, H);
    const data = imageData.data;

    // alpha = current mask; r is 255 wherever we painted red
    for (let i = 0, j = 0; j < exp.mask.length; i += 4, j++) {
      exp.mask[j] = (imageData.data[i + 3]) / 255; // 0..1
    }

    this.maskData = exp.mask;

    // Update the dodge mask preview
    this.updateDodgeMaskPreview(this.selectedExposureId);
  },

  // Clear the mask
  clearMask: function() {
    if (!this.maskCtx) return;

    // Clear the canvas
    this.maskCtx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);

    // Get the selected exposure
    if (!this.selectedExposureId) return;
    const selectedExposure = this.exposures.find(exp => exp.id === this.selectedExposureId);
    if (!selectedExposure || !selectedExposure.mask) return;

    // Reset the mask data array
    selectedExposure.mask.fill(0);

    // Also update the global maskData for compatibility
    this.maskData = selectedExposure.mask;

    // Update the dodge mask preview
    this.updateDodgeMaskPreview(this.selectedExposureId);
  },

  // Update the tool buttons to show which one is active
  updateToolButtons: function() {
    const dodgeButton = document.getElementById('dodge-tool');
    const eraseButton = document.getElementById('erase-tool');

    dodgeButton.classList.toggle('active', this.activeTool === 'dodge');
    eraseButton.classList.toggle('active', this.activeTool === 'erase');
  },

  // Handle image upload
  handleImageUpload: function(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        // Store original image
        this.originalImage = img;

        // Reset current project ID for auto-save (this is a new project)
        this.currentProjectId = null;

        // Clear existing exposures
        this.exposures = [];
        document.getElementById('exposures-list').innerHTML = '';

        // Add a default exposure of 16 seconds
        this.addExposure();

        // Convert to B&W negative
        // This will trigger requestProcess once the negative image is loaded
        this.convertToNegative(img);
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  },

  // Convert image to B&W negative
  convertToNegative: function(img) {
    // Create canvas for image processing
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    // Check if image has valid dimensions
    if (!img.width || !img.height) {
      console.error('Image has invalid dimensions:', img.width, 'x', img.height);
      return; // Exit early to prevent error
    }

    // Set canvas dimensions to match image
    canvas.width = img.width;
    canvas.height = img.height;

    // Draw image on canvas
    ctx.drawImage(img, 0, 0);

    // Get image data
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    // --- build the negative and the transmission in one pass ---
    const npx = imageData.data.length / 4;
    this.trans = new Float32Array(npx);
    this.logTrans = new Float32Array(npx);
    const LOG10E = Math.LOG10E;
    const EPS = 1e-6;

    for (let i = 0, j = 0; j < npx; i += 4, j++) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;

      // Make/display a NEGATIVE
      const inverted = 255 - gray;
      data[i] = data[i + 1] = data[i + 2] = inverted;

      // Transmission for printing must come from the NEGATIVE
      const t = inverted * (1 / 255);         // 0..1, bright neg = high trans
      const safeT = t > EPS ? t : EPS;
      this.trans[j] = t;
      this.logTrans[j] = Math.log(safeT) * LOG10E;
    }

    // Convert to grayscale and invert
    for (let i = 0; i < data.length; i += 4) {
      // Convert to grayscale using luminance formula
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;

      // Invert (negative)
      const inverted = 255 - gray;

      // Set RGB channels to the inverted grayscale value
      data[i] = inverted;
      data[i + 1] = inverted;
      data[i + 2] = inverted;
      // Alpha channel remains unchanged
    }

    // Put processed image data back on canvas
    ctx.putImageData(imageData, 0, 0);

    // Store negative image
    const negativeImg = new Image();
    const self = this; // Store reference to 'this' for use in the onload callback

    // Wait for the image to load before proceeding
    negativeImg.onload = () => {
      this.negativeImage = negativeImg;       // off-DOM bitmap for pixels

      // Show the displayed <img> and point it at the data URL
      const el = this.negativeImageEl;
      el.src = negativeImg.src;
      el.classList.remove('hidden');

      document.querySelector('.tool-controls')?.classList.remove('hidden');
      document.getElementById('mask-canvas')?.classList.remove('hidden');

      if (this.maskCtx) {
        this.maskCtx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
        if (this.maskData) this.maskData.fill(0);
      }

      // Defer to ensure <img> has non-zero layout box
      requestAnimationFrame(() => {
        this.initMaskCanvas();
        this.positionMaskCanvasToImage();
        this.updateMaskCanvas();
        this.updateAllDodgeMaskPreviews();
      });

      if (this.exposures.length > 0) this.requestProcess();
    };


    // Set the source after setting up the onload handler
    negativeImg.src = canvas.toDataURL();
  },

  requestProcess(delayMs = 60, rect = null) {
    // Coalesce rapid calls (grade/time sliders, painting bursts, etc.)
    if (this._processTimer) clearTimeout(this._processTimer);
    this._processTimer = setTimeout(() => {
      this._processTimer = null;
      // Always call processImage for now, as processImageRect is not implemented yet
      this.processImage();
    }, delayMs);
  },

  // Update paper information display
  updatePaperInfo: function() {
    // Paper info is now hidden to save space, so we don't need to update it
    // We still keep this function for future reference or if we want to show the info again
    const paper = this.papers[this.paperType];

    // Update the paper type dropdown's title attribute to show info on hover
    const paperTypeSelect = document.getElementById('paper-type');
    if (paperTypeSelect) {
      paperTypeSelect.title = `${paper.name}: ${paper.description} (Density: ${paper.maxDensity}, Base: ${paper.baseExposure}s)`;
    }
  },

  // Add a new exposure
  addExposure: function() {
    // Check if there was only one exposure before adding the new one
    const wasOnlyOneExposure = this.exposures.length === 1;

    // Initialize mask data if we have a negative image
    let initialMask = null;
    if (this.negativeImage) {
      const width = this.negativeImage.naturalWidth;
      const height = this.negativeImage.naturalHeight;
      initialMask = new Float32Array(width * height);
    }

    // Create new exposure object
    const exposure = {
      id: Date.now(), // Unique ID
      time: 32, // Default time (seconds)
      grade: 5, // Default grade (0-11)
      mask: initialMask // Initialize mask data for the exposure
    };

    // Add to exposures array
    this.exposures.push(exposure);

    // If there was only one exposure before, enable its delete button
    if (wasOnlyOneExposure) {
      const existingExposureElement = document.querySelector('.exposure-item');
      if (existingExposureElement) {
        const deleteButton = existingExposureElement.querySelector('.delete-button');
        if (deleteButton) {
          deleteButton.disabled = false;
        }
      }
    }

    // Create exposure UI element
    this.createExposureElement(exposure);

    // Select this exposure if it's the first one
    if (this.exposures.length === 1) {
      this.selectExposure(exposure.id);
    }

    // Automatically process image after adding a new exposure
    if (this.negativeImage) {
      this.requestProcess();
    }
  },

  // Select an exposure
  selectExposure: function(exposureId) {
    // Update selected exposure ID
    this.selectedExposureId = exposureId;

    // Update UI to indicate selected exposure
    const exposureElements = document.querySelectorAll('.exposure-item');
    exposureElements.forEach(element => {
      const id = parseInt(element.dataset.exposureId);
      if (id === exposureId) {
        element.classList.add('selected');
      } else {
        element.classList.remove('selected');
      }
    });

    // Get the selected exposure
    const exposure = this.exposures.find(exp => exp.id === exposureId);
    if (!exposure) return;

    // Initialize mask data for this exposure if it doesn't exist
    if (exposure.mask === null && this.negativeImage) {
      const width  = this.negativeImage.naturalWidth;   // was .width
      const height = this.negativeImage.naturalHeight;  // was .height
      exposure.mask = new Float32Array(width * height);
    }

    // Update mask canvas to show this exposure's mask
    this.updateMaskCanvas();

    // Update the dodge mask preview for this exposure
    this.updateDodgeMaskPreview(exposureId);

    // ← NEW: reflect selection immediately in the main render
    this.requestProcess(0);
  },

  // Update all dodge mask previews
  updateAllDodgeMaskPreviews: function() {
    if (!this.negativeImage) return;

    // Update preview for each exposure
    this.exposures.forEach(exposure => {
      this.updateDodgeMaskPreview(exposure.id);
    });
  },

  // Update mask canvas to show the selected exposure's mask
  updateMaskCanvas: function() {
    if (!this.maskCtx || !this.selectedExposureId) return;

    // If CSS size isn't ready yet, defer one frame
    const imgRect = this.negativeImageEl?.getBoundingClientRect?.() || { width: 0, height: 0 };
    if (imgRect.width < 2 || imgRect.height < 2 ||
        !this.maskCanvas || this.maskCanvas.width < 2 || this.maskCanvas.height < 2) {
      requestAnimationFrame(() => this.updateMaskCanvas());
      return;
    }

    // Get the selected exposure
    const exposure = this.exposures.find(exp => exp.id === this.selectedExposureId);
    if (!exposure || !exposure.mask) return;

    // Clear the canvas
    this.maskCtx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);

    // Draw the mask on the canvas - now 1:1 since canvas size matches image size
    const imageData = this.maskCtx.createImageData(this.maskCanvas.width, this.maskCanvas.height);
    const data = imageData.data;

    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      // Skip if out of bounds
      if (j >= exposure.mask.length) continue;

      // Get the mask value
      const maskValue = exposure.mask[j];

      // Set the pixel color based on the mask value with enhanced visibility
      if (maskValue > 0) {
        // Dodge: red with white outline for better visibility
        data[i] = 255;
        data[i+1] = Math.max(0, 255 - maskValue*255);
        data[i+2] = Math.max(0, 255 - maskValue*255);
        data[i+3] = Math.round(maskValue * 255); // remove Math.max(60, ...)
      } else {
        // No mask: transparent
        data[i + 3] = 0; // A (transparent)
      }
    }

    // Put the image data on the canvas
    this.maskCtx.putImageData(imageData, 0, 0);

    // Update the maskData property to match the selected exposure's mask
    this.maskData = exposure.mask;

    this.requestProcess(0);
  },

  // Create exposure UI element
  createExposureElement: function(exposure) {
    // Get template and exposures list
    const template = document.querySelector('.exposure-template').innerHTML;
    const exposuresList = document.getElementById('exposures-list');

    // Create new element
    const exposureElement = document.createElement('div');
    exposureElement.innerHTML = template;

    // Get the exposure item element
    const exposureItem = exposureElement.querySelector('.exposure-item');

    // Set exposure ID as a data attribute
    exposureItem.dataset.exposureId = exposure.id;

    // Add click handler to select this exposure
    exposureItem.addEventListener('click', (e) => {
      // Don't trigger if clicking on a control
      if (e.target.tagName === 'SELECT' || e.target.tagName === 'BUTTON') return;

      this.selectExposure(exposure.id);
    });

    // Add event listeners for the exposure buttons
    const moveUpButton = exposureItem.querySelector('.move-up-button');
    const moveDownButton = exposureItem.querySelector('.move-down-button');
    const deleteButton = exposureItem.querySelector('.delete-button');

    // Find the index of the exposure
    const index = this.exposures.findIndex(exp => exp.id === exposure.id);

    // Disable buttons based on position and count
    // Disable delete button if there's only one exposure
    if (this.exposures.length === 1) {
      deleteButton.disabled = true;
    }

    // Disable move up button if it's the first exposure
    if (index === 0) {
      moveUpButton.disabled = true;
    }

    // Disable move down button if it's the last exposure
    if (index === this.exposures.length - 1) {
      moveDownButton.disabled = true;
    }

    moveUpButton.addEventListener('click', () => {
      this.moveExposureUp(exposure.id);
    });

    moveDownButton.addEventListener('click', () => {
      this.moveExposureDown(exposure.id);
    });

    deleteButton.addEventListener('click', () => {
      this.deleteExposure(exposure.id);
    });

    // Set exposure number
    exposureElement.querySelector('.exposure-number').textContent = this.exposures.length;

    // Set initial values
    const timeSelect = exposureElement.querySelector('.exposure-time');
    const gradeSelect = exposureElement.querySelector('.exposure-grade');

    // Find the closest available time value in our dropdown
    const timeOptions = Array.from(timeSelect.options).map(opt => parseFloat(opt.value));
    const closestTime = timeOptions.reduce((prev, curr) => {
      return (Math.abs(curr - exposure.time) < Math.abs(prev - exposure.time) ? curr : prev);
    });
    timeSelect.value = closestTime;

    // Set the grade select value
    gradeSelect.value = exposure.grade;

    // Update the custom grade display to match the selected grade
    const gradeSelector = exposureElement.querySelector('.grade-selector');
    const gradeDisplay = gradeSelector.querySelector('.grade-display');
    const selectedOption = gradeSelector.querySelector(`.grade-option[data-value="${exposure.grade}"]`);

    if (gradeDisplay && selectedOption) {
      gradeDisplay.textContent = selectedOption.textContent;
      gradeDisplay.className = 'grade-display grade-' + exposure.grade;
    }

    // Initialize dodge mask preview canvas
    const previewCanvas = exposureElement.querySelector('.dodge-mask-preview');
    if (previewCanvas) {
      // Set a data attribute to link the canvas to the exposure
      previewCanvas.dataset.exposureId = exposure.id;

      // Update the preview if we have a negative image
      if (this.negativeImage) {
        this.updateDodgeMaskPreview(exposure.id);
      }
    }

    // Add event listeners
    timeSelect.addEventListener('change', (e) => {
      const value = parseFloat(e.target.value);

      // Update exposure object
      const index = this.exposures.findIndex(exp => exp.id === exposure.id);
      if (index !== -1) {
        this.exposures[index].time = value;
        // Automatically process image when exposure time changes
        if (this.negativeImage) {
          this.requestProcess();
        }
      }
    });

    // Set up custom grade selector
    // Use the existing gradeSelector variable declared above
    const gradeOptions = gradeSelector.querySelector('.grade-options');
    const gradeOptionElements = gradeSelector.querySelectorAll('.grade-option');

    // Show/hide grade options when clicking on the display
    gradeDisplay.addEventListener('click', () => {
      gradeOptions.classList.toggle('show');

      // Close other open grade selectors
      document.querySelectorAll('.grade-options.show').forEach(el => {
        if (el !== gradeOptions) {
          el.classList.remove('show');
        }
      });
    });

    // Close grade options when clicking outside
    document.addEventListener('click', (e) => {
      if (!gradeSelector.contains(e.target)) {
        gradeOptions.classList.remove('show');
      }
    });

    // Handle grade option selection
    gradeOptionElements.forEach(option => {
      option.addEventListener('click', () => {
        const value = parseInt(option.dataset.value);
        const text = option.textContent;

        // Update display
        gradeDisplay.textContent = text;
        gradeDisplay.className = 'grade-display grade-' + value;

        // Update hidden select
        gradeSelect.value = value;

        // Hide options
        gradeOptions.classList.remove('show');

        // Trigger change event on select
        const event = new Event('change');
        gradeSelect.dispatchEvent(event);
      });
    });

    // Original select change handler
    gradeSelect.addEventListener('change', (e) => {
      const value = parseInt(e.target.value);

      // Update exposure object
      const index = this.exposures.findIndex(exp => exp.id === exposure.id);
      if (index !== -1) {
        this.exposures[index].grade = value;
        // Automatically process image when exposure grade changes
        if (this.negativeImage) {
          this.requestProcess();
        }
      }
    });

    // Add to DOM
    exposuresList.appendChild(exposureElement.firstElementChild);
  },

  // Move an exposure up in the list
  moveExposureUp: function(exposureId) {
    // Find the index of the exposure
    const index = this.exposures.findIndex(exp => exp.id === exposureId);

    // If it's already at the top, do nothing
    if (index <= 0) return;

    // Swap with the exposure above it
    const temp = this.exposures[index];
    this.exposures[index] = this.exposures[index - 1];
    this.exposures[index - 1] = temp;

    // Update the DOM
    this.refreshExposuresList();

    // Select the moved exposure
    this.selectExposure(exposureId);

    // Update all views
    this.requestProcess();
  },

  // Move an exposure down in the list
  moveExposureDown: function(exposureId) {
    // Find the index of the exposure
    const index = this.exposures.findIndex(exp => exp.id === exposureId);

    // If it's already at the bottom, do nothing
    if (index === -1 || index >= this.exposures.length - 1) return;

    // Swap with the exposure below it
    const temp = this.exposures[index];
    this.exposures[index] = this.exposures[index + 1];
    this.exposures[index + 1] = temp;

    // Update the DOM
    this.refreshExposuresList();

    // Select the moved exposure
    this.selectExposure(exposureId);

    // Update all views
    this.requestProcess();
  },

  // Delete an exposure
  deleteExposure: function(exposureId) {
    // Find the index of the exposure
    const index = this.exposures.findIndex(exp => exp.id === exposureId);
    if (index === -1) return;

    // Store the ID of the exposure to select after deletion
    let nextSelectedId = null;

    // If we're deleting the selected exposure, select the next one or the previous one
    if (this.selectedExposureId === exposureId) {
      if (index < this.exposures.length - 1) {
        // Select the next exposure
        nextSelectedId = this.exposures[index + 1].id;
      } else if (index > 0) {
        // Select the previous exposure
        nextSelectedId = this.exposures[index - 1].id;
      }
      // If there's no next or previous exposure, selectedExposureId will be null
    }

    // Remove the exposure from the array
    this.exposures.splice(index, 1);

    // Update the DOM
    this.refreshExposuresList();

    // Select the next exposure if available
    if (nextSelectedId) {
      this.selectExposure(nextSelectedId);
    } else if (this.exposures.length > 0) {
      this.selectExposure(this.exposures[0].id);
    } else {
      this.selectedExposureId = null;
    }

    // Update all views
    this.requestProcess();
  },

  // Refresh the exposures list in the DOM
  refreshExposuresList: function() {
    // Clear the exposures list
    const exposuresList = document.getElementById('exposures-list');
    exposuresList.innerHTML = '';

    // Recreate all exposure elements
    for (let i = 0; i < this.exposures.length; i++) {
      const exposure = this.exposures[i];
      this.createExposureElement(exposure);
    }
  },

  // Update the dodge mask preview for a specific exposure
  updateDodgeMaskPreview: function(exposureId) {
    if (!this.negativeImage) return;

    // Find the exposure
    const exposure = this.exposures.find(exp => exp.id === exposureId);
    if (!exposure) return;

    // Find the preview canvas
    const previewCanvas = document.querySelector(`.dodge-mask-preview[data-exposure-id="${exposureId}"]`);
    if (!previewCanvas) return;

    // Set canvas dimensions to match the aspect ratio of the negative image
    const naturalWidth = this.negativeImage.naturalWidth || 1;  // Ensure non-zero value
    const naturalHeight = this.negativeImage.naturalHeight || 1;  // Ensure non-zero value
    const aspectRatio = naturalWidth / naturalHeight;

    const container = previewCanvas.parentElement;
    const containerWidth = container.offsetWidth || 1;  // Ensure non-zero value
    const containerHeight = container.offsetHeight || 1;  // Ensure non-zero value

    if (containerWidth < 2 || containerHeight < 2) {
      // Wait for layout, then try again
      requestAnimationFrame(() => this.updateDodgeMaskPreview(exposureId));
      return;
    }

    // Calculate dimensions that fit within the container while maintaining aspect ratio
    let canvasWidth, canvasHeight;

    if (aspectRatio > 1) {
      // Landscape image: fit to width
      canvasWidth = containerWidth;
      canvasHeight = containerWidth / aspectRatio;
    } else {
      // Portrait or square image: fit to height
      canvasHeight = containerHeight;
      canvasWidth = containerHeight * aspectRatio;
    }

    // Ensure canvas dimensions are at least 1 pixel
    canvasWidth = Math.max(1, Math.floor(canvasWidth));
    canvasHeight = Math.max(1, Math.floor(canvasHeight));

    previewCanvas.width = canvasWidth;
    previewCanvas.height = canvasHeight;

    const ctx = previewCanvas.getContext('2d');

    // Clear the canvas
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    // Draw the negative image (scaled down)
    ctx.drawImage(this.negativeImage, 0, 0, canvasWidth, canvasHeight);

    // If there's no mask data, we're done
    if (!exposure.mask) return;

    // Check if canvas dimensions are valid before getting image data
    if (canvasWidth <= 0 || canvasHeight <= 0) {
      console.warn('Invalid canvas dimensions for dodge mask preview:', canvasWidth, canvasHeight);
      return;
    }

    // Get image data to apply the mask
    const imageData = ctx.getImageData(0, 0, canvasWidth, canvasHeight);
    const data = imageData.data;

    // Calculate scaling factors for the mask
    const scaleX = this.negativeImage.naturalWidth / canvasWidth;
    const scaleY = this.negativeImage.naturalHeight / canvasHeight;

    // Apply the mask to the preview
    for (let y = 0; y < canvasHeight; y++) {
      for (let x = 0; x < canvasWidth; x++) {
        // Calculate the corresponding position in the original mask
        const origX = Math.floor(x * scaleX);
        const origY = Math.floor(y * scaleY);
        const origIndex = origY * this.negativeImage.naturalWidth + origX;

        // Get mask value (0 to 1)
        const maskValue = exposure.mask && origIndex < exposure.mask.length ? exposure.mask[origIndex] : 0;

        if (maskValue > 0) {
          // Calculate pixel index in the preview image data
          const pixelIndex = (y * canvasWidth + x) * 4;

          // Apply a red tint to indicate dodge areas
          data[pixelIndex] = 255;  // Red channel at maximum
          data[pixelIndex + 1] *= (1 - maskValue);  // Reduce green based on mask value
          data[pixelIndex + 2] *= (1 - maskValue);  // Reduce blue based on mask value
          // Alpha channel remains unchanged
        }
      }
    }

    // Put the modified image data back on the canvas
    ctx.putImageData(imageData, 0, 0);
  },

  // Update exposure numbers after removal
  updateExposureNumbers: function() {
    const exposureElements = document.querySelectorAll('.exposure-item');
    exposureElements.forEach((element, index) => {
      element.querySelector('.exposure-number').textContent = index + 1;
    });
  },

  processImage: function() {
    if (!this.negativeImage || this.exposures.length === 0) {
      return;
    }
    const paper = this.papers[this.paperType];
    const Dmin  = paper.Dmin;
    const Dmax  = paper.Dmax;
    const spanD = Dmax - Dmin;

    // Size working canvas once
    const W = this.negativeImage.naturalWidth;
    const H = this.negativeImage.naturalHeight;

    // Check if image dimensions are valid
    if (W <= 0 || H <= 0) {
      console.warn('Invalid image dimensions in processImage:', W, 'x', H);
      return;
    }

    if (this.workCanvas.width !== W || this.workCanvas.height !== H) {
      this.workCanvas.width = W;
      this.workCanvas.height = H;
    }

    // Draw the negative image to the working canvas first
    const ctx = this.workCtx;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(this.negativeImage, 0, 0, W, H);

    // Prepare ImageData buffer
    let imageData = ctx.getImageData(0, 0, W, H);
    const data = imageData.data;

    // Precompute per-exposure constants
    const LOG10E = Math.LOG10E;
    const log10BaseE = Math.log(paper.baseExposure) * LOG10E;
    const log10Two = Math.LOG10E * Math.LN2;

    const pre = new Array(this.exposures.length);
    for (let i = 0; i < this.exposures.length; i++) {
      const ex = this.exposures[i];
      const p  = paper.gradeParams[ex.grade];
      pre[i] = {
        k: p.k,
        E0: log10BaseE + p.speedShiftStops * log10Two,  // in log10 space
        logTime: Math.log(ex.time) * LOG10E,            // log10(time)
        mask: ex.mask || null
      };
    }

    const npx = (data.length / 4) | 0;
    const sigmoid = (x) => {
      const L = this.sigmoidLUT;
      if (x <= L.lo) return 0;
      if (x >= L.hi) return 1;
      return L.lut[((x - L.lo) / L.step) | 0];
    };

    // Main loop
    for (let i = 0, j = 0; j < npx; i += 4, j++) {
      // Cached logTrans (log10(trans))
      const logT = this.logTrans[j];

      let Dsum = 0;
      for (let e = 0; e < pre.length; e++) {
        const ex = pre[e];
        // mask reduces exposure by (1 - m); do it in linear then log
        const m = ex.mask ? ex.mask[j] : 0;     // 0..1
        const safeMaskMul = (m > 0) ? Math.max(1e-6, 1 - m) : 1;
        const logMask = (safeMaskMul === 1) ? 0 : Math.log(safeMaskMul) * LOG10E;

        const logE = ex.logTime + logT + logMask;

        // correct sign: low exposure → sigmoid ≈ 0 → D ≈ Dmin (white)
        const x = ex.k * (logE - ex.E0);
        const sig = sigmoid(x);
        const Dpix = Dmin + spanD * sig;

        const Dexcess = Dpix - Dmin;
        if (Dexcess > 0) {
          Dsum += Dexcess;
          if (Dsum >= spanD) { // early exit, already maxed
            Dsum = spanD;
            break;
          }
        }
      }

      const Dfinal = (Dsum >= spanD) ? Dmax : (Dmin + Dsum);
      const frac = Math.max(0, Math.min(1, (Dfinal - Dmin) / spanD)); // clamp
      const valueUnclamped = Math.round(255 * (1 - frac)); // higher density -> lower value (darker)
      const value = Math.max(0, Math.min(255, valueUnclamped));

      // Paper tone
      let tone;
      if (value > 192)      tone = paper.colorTone.highlights;
      else if (value > 64)  tone = paper.colorTone.midtones;
      else                  tone = paper.colorTone.shadows;

      data[i]     = (value * tone.r) | 0;
      data[i + 1] = (value * tone.g) | 0;
      data[i + 2] = (value * tone.b) | 0;
      // data[i+3] stays as-is (opaque by default)
      data[i + 3] = 255;
    }

    // Blit once
    ctx.putImageData(imageData, 0, 0);

    // Prefer drawing directly to a canvas in the DOM
    // Draw from workCanvas into visible canvas
    if (this.resultCanvasEl) {
        if (this.resultCanvasEl.width !== W || this.resultCanvasEl.height !== H) {
            this.resultCanvasEl.width = W;
            this.resultCanvasEl.height = H;
        }
        const rc = this.resultCanvasEl.getContext('2d');
        rc.drawImage(this.workCanvas, 0, 0);

        // Show result canvas, hide placeholder & img
        this.resultCanvasEl.classList.remove('hidden');
        if (this.resultImageEl) this.resultImageEl.classList.add('hidden');
    } else if (this.resultImageEl) {
        // Fallback path
        this.resultImageEl.src = this.workCanvas.toDataURL();
        this.resultImageEl.classList.remove('hidden');
    }

    // OPTIONAL: compute histogram less often or on demand; if you keep it here,
    // consider downsampling inside generateHistogram for speed.
    this.generateHistogram(data);
    this.drawHistogram();

    // Update mask previews
    this.updateAllDodgeMaskPreviews();

    // Auto-save project after processing
    this.autoSaveProject();
  },

  // Auto-save project
  autoSaveProject: async function() {
    if (!this.originalImage) {
      return; // Don't save if there's no image
    }

    // Create a project object to store all the data
    const project = {
      paperType: this.paperType,
      exposures: []
    };

    // Save exposures and masks
    for (let i = 0; i < this.exposures.length; i++) {
      const exposure = this.exposures[i];

      // Convert Float32Array mask to regular array for JSON serialization
      let maskArray = null;
      if (exposure.mask) {
        maskArray = Array.from(exposure.mask);
      }

      project.exposures.push({
        id: exposure.id,
        time: exposure.time,
        grade: exposure.grade,
        mask: maskArray
      });
    }

    // Check if we're using File System Access API
    if (this.directoryHandle && this.currentFileHandle) {
      // Save project data to a JSON file next to the image file
      await this.saveProjectToFileSystem(project);
    } else {
      // Legacy localStorage saving

      // Convert original image to data URL
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = this.originalImage.width;
      canvas.height = this.originalImage.height;
      ctx.drawImage(this.originalImage, 0, 0);
      project.imageDataURL = canvas.toDataURL('image/jpeg');

      // Add result image to project
      if (this.workCanvas) {
        project.resultImageURL = this.workCanvas.toDataURL('image/jpeg');
      }

      // Generate a unique ID for the project or use existing one
      let projectId = this.currentProjectId;
      let isNewProject = false;

      if (!projectId) {
        projectId = Date.now().toString();
        this.currentProjectId = projectId;
        isNewProject = true;
      }

      project.id = projectId;

      // Only set a new name for new projects
      if (isNewProject) {
        project.name = 'Project ' + new Date().toLocaleString();
      } else {
        // Try to get the existing project name
        try {
          const existingProject = JSON.parse(localStorage.getItem('darkroomProject_' + projectId));
          if (existingProject && existingProject.name) {
            project.name = existingProject.name;
          } else {
            project.name = 'Project ' + new Date().toLocaleString();
          }
        } catch (error) {
          console.error('Error getting existing project name:', error);
          project.name = 'Project ' + new Date().toLocaleString();
        }
      }

      // Save to localStorage
      this.saveProjectToLocalStorage(projectId, project);
    }
  },

  // Save project to file system
  saveProjectToFileSystem: async function(project) {
    try {
      if (!this.directoryHandle || !this.currentFileHandle) {
        console.error('No directory or file handle available');
        return;
      }

      // Check if we have permission to access the directory
      if (!await ensureDirPermission()) {
        console.warn('Permission to access directory was denied. Please select the folder again.');
        return;
      }

      // Get the file name without extension
      const fileName = this.currentFileHandle.name;
      const baseName = fileName.substring(0, fileName.lastIndexOf('.'));
      const jsonFileName = baseName + '.json';

      // Create or get the JSON file handle
      let jsonFileHandle;
      try {
        // Try to get existing file
        jsonFileHandle = await this.directoryHandle.getFileHandle(jsonFileName);
      } catch (error) {
        // File doesn't exist, create it
        jsonFileHandle = await this.directoryHandle.getFileHandle(jsonFileName, { create: true });
      }

      // Create a writable stream
      const writable = await jsonFileHandle.createWritable();

      // Convert project to JSON string
      const jsonString = JSON.stringify(project);

      // Write the JSON data
      await writable.write(jsonString);

      // Close the stream
      await writable.close();

      console.log('Project saved to file system:', jsonFileName);
    } catch (error) {
      console.error('Error saving project to file system:', error);
      alert('Error saving project: ' + error.message);
    }
  },

  // Generate histogram data from image data
  generateHistogram: function(imageData) {
    // Initialize histogram data (256 bins for each channel)
    const histData = {
      r: new Array(256).fill(0),
      g: new Array(256).fill(0),
      b: new Array(256).fill(0)
    };

    // Count pixel values for each channel
    for (let i = 0; i < imageData.length; i += 4) {
      histData.r[imageData[i]]++;
      histData.g[imageData[i + 1]]++;
      histData.b[imageData[i + 2]]++;
    }

    // Find the maximum count for normalization
    let maxCount = 0;
    for (let i = 0; i < 256; i++) {
      maxCount = Math.max(maxCount, histData.r[i], histData.g[i], histData.b[i]);
    }

    // Normalize the data (0-1 range)
    for (let i = 0; i < 256; i++) {
      histData.r[i] /= maxCount;
      histData.g[i] /= maxCount;
      histData.b[i] /= maxCount;
    }

    // Store the histogram data
    this.histogramData = histData;
  },

  // Draw histogram on canvas
  drawHistogram: function() {
    if (!this.histogramData) return;

    // Show histogram container
    const histogramContainer = document.getElementById('histogram-container');
    if (histogramContainer) {
      histogramContainer.classList.remove('hidden');
    }

    const canvas = document.getElementById('histogram-canvas');
    if (!canvas) return;

    // Ensure canvas dimensions match its display size
    const displayWidth = canvas.clientWidth;
    const displayHeight = canvas.clientHeight;
    if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
      canvas.width = displayWidth;
      canvas.height = displayHeight;
    }

    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    // Draw background (dark mode)
    ctx.fillStyle = '#1a1a1a'; // Very dark gray to match the darkroom theme
    ctx.fillRect(0, 0, width, height);

    // Draw grid lines (dark mode)
    ctx.strokeStyle = '#3a3a3a'; // Darker gray for grid lines
    ctx.lineWidth = 1;

    // Horizontal grid lines (25%, 50%, 75%)
    for (let i = 1; i <= 3; i++) {
      const y = height - (height * (i / 4));
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    // Draw histogram for each channel
    const drawChannel = (data, color, alpha) => {
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.moveTo(0, height);

      for (let i = 0; i < 256; i++) {
        const x = (i / 255) * width;
        const y = height - (data[i] * height);
        ctx.lineTo(x, y);
      }

      ctx.lineTo(width, height);
      ctx.closePath();
      ctx.fill();
    };

    // Draw channels from back to front with different alpha values
    drawChannel(this.histogramData.b, 'blue', 0.5);
    drawChannel(this.histogramData.g, 'green', 0.5);
    drawChannel(this.histogramData.r, 'red', 0.5);

    // Reset alpha
    ctx.globalAlpha = 1.0;

    // Draw border (dark mode)
    ctx.strokeStyle = '#4a4a4a'; // Darker gray for border
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, width, height);
  },

  // Save project to a JSON file and localStorage
  saveProject: async function() {
    if (!this.originalImage) {
      alert('Please load an image first.');
      return;
    }

    // Create a project object to store all the data
    const project = {
      paperType: this.paperType,
      exposures: []
    };

    // Save exposures and masks
    for (let i = 0; i < this.exposures.length; i++) {
      const exposure = this.exposures[i];

      // Convert Float32Array mask to regular array for JSON serialization
      let maskArray = null;
      if (exposure.mask) {
        maskArray = Array.from(exposure.mask);
      }

      project.exposures.push({
        id: exposure.id,
        time: exposure.time,
        grade: exposure.grade,
        mask: maskArray
      });
    }

    // Check if we're using File System Access API
    if (this.directoryHandle && this.currentFileHandle) {
      // Save project data to a JSON file next to the image file
      await this.saveProjectToFileSystem(project);

      // Show confirmation
      alert('Project saved successfully to ' + this.currentFileHandle.name.replace(/\.[^/.]+$/, '.json'));
    } else {
      // Legacy localStorage saving

      // Convert original image to data URL
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = this.originalImage.width;
      canvas.height = this.originalImage.height;
      ctx.drawImage(this.originalImage, 0, 0);
      project.imageDataURL = canvas.toDataURL('image/jpeg');

      // Add result image to project
      if (this.workCanvas) {
        project.resultImageURL = this.workCanvas.toDataURL('image/jpeg');
      }

      // Generate a unique ID for the project or use existing one
      let projectId = this.currentProjectId;
      let isNewProject = false;

      if (!projectId) {
        projectId = Date.now().toString();
        this.currentProjectId = projectId;
        isNewProject = true;
      }

      project.id = projectId;

      // Only set a new name for new projects
      if (isNewProject) {
        project.name = 'Project ' + new Date().toLocaleString();
      } else {
        // Try to get the existing project name
        try {
          const existingProject = JSON.parse(localStorage.getItem('darkroomProject_' + projectId));
          if (existingProject && existingProject.name) {
            project.name = existingProject.name;
          } else {
            project.name = 'Project ' + new Date().toLocaleString();
          }
        } catch (error) {
          console.error('Error getting existing project name:', error);
          project.name = 'Project ' + new Date().toLocaleString();
        }
      }

      // Convert project to JSON string
      const jsonString = JSON.stringify(project);

      // Save to localStorage
      this.saveProjectToLocalStorage(projectId, project);

      // Create a download link
      const blob = new Blob([jsonString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'darkroom-project.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  },

  // Load project from a JSON file
  loadProject: function(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const project = JSON.parse(event.target.result);

        // Set paper type
        this.paperType = project.paperType;
        document.getElementById('paper-type').value = project.paperType;
        this.updatePaperInfo();

        // Clear existing exposures
        this.exposures = [];
        document.getElementById('exposures-list').innerHTML = '';

        // Load image
        const img = new Image();
        img.onload = () => {
          // Store original image
          this.originalImage = img;

          // Convert to B&W negative
          this.convertToNegative(img);

          // Create exposures
          for (let i = 0; i < project.exposures.length; i++) {
            const savedExposure = project.exposures[i];

            // Create new exposure object
            const exposure = {
              id: savedExposure.id,
              time: savedExposure.time,
              grade: savedExposure.grade,
              mask: null
            };

            // Convert mask array back to Float32Array if it exists
            if (savedExposure.mask) {
              exposure.mask = new Float32Array(savedExposure.mask);
            }

            // Add to exposures array
            this.exposures.push(exposure);

            // Create exposure UI element
            this.createExposureElement(exposure);
          }

          // Make sure mask canvas is initialized and positioned before selecting exposure
          if (this.negativeImage) {
            this.initMaskCanvas();
            this.positionMaskCanvasToImage();
          }

          // Select first exposure if any exist
          if (this.exposures.length > 0) {
            this.selectExposure(this.exposures[0].id);
          }

          // Process image
          this.requestProcess();
        };
        img.src = project.imageDataURL;

      } catch (error) {
        console.error('Error loading project:', error);
        alert('Error loading project. The file may be corrupted or in an invalid format.');
      }
    };
    reader.readAsText(file);

    // Reset the file input so the same file can be loaded again if needed
    e.target.value = '';
  },

  // Save project to localStorage
  saveProjectToLocalStorage: function(projectId, project) {
    try {
      // Get existing projects list or create a new one
      let projectsList = JSON.parse(localStorage.getItem('darkroomProjects')) || [];

      // Check if project with this ID already exists in the list
      const existingIndex = projectsList.findIndex(p => p.id === projectId);

      if (existingIndex >= 0) {
        // Update existing project in the list
        projectsList[existingIndex] = {
          id: projectId,
          name: project.name,
          timestamp: Date.now(),
          thumbnailURL: project.resultImageURL
        };
      } else {
        // Add the new project to the list
        projectsList.push({
          id: projectId,
          name: project.name,
          timestamp: Date.now(),
          thumbnailURL: project.resultImageURL
        });
      }

      // Save the updated list
      localStorage.setItem('darkroomProjects', JSON.stringify(projectsList));

      // Save the full project data
      localStorage.setItem('darkroomProject_' + projectId, JSON.stringify(project));

      console.log('Project saved to localStorage:', projectId);
    } catch (error) {
      console.error('Error saving project to localStorage:', error);
    }
  },

  // Get all projects from localStorage
  getProjectsFromLocalStorage: function() {
    try {
      return JSON.parse(localStorage.getItem('darkroomProjects')) || [];
    } catch (error) {
      console.error('Error getting projects from localStorage:', error);
      return [];
    }
  },

  // Get a specific project from localStorage
  getProjectFromLocalStorage: function(projectId) {
    try {
      return JSON.parse(localStorage.getItem('darkroomProject_' + projectId));
    } catch (error) {
      console.error('Error getting project from localStorage:', error);
      return null;
    }
  },

  // Load project from localStorage
  loadProjectFromLocalStorage: function(projectId) {
    const project = this.getProjectFromLocalStorage(projectId);
    if (!project) {
      console.error('Project not found in localStorage:', projectId);
      return;
    }

    // Set current project ID for auto-save
    this.currentProjectId = projectId;

    // Set paper type
    this.paperType = project.paperType;
    document.getElementById('paper-type').value = project.paperType;
    this.updatePaperInfo();

    // Clear existing exposures
    this.exposures = [];
    document.getElementById('exposures-list').innerHTML = '';

    // Load image
    const img = new Image();
    img.onload = () => {
      // Store original image
      this.originalImage = img;

      // Convert to B&W negative
      this.convertToNegative(img);

      // Create exposures
      for (let i = 0; i < project.exposures.length; i++) {
        const savedExposure = project.exposures[i];

        // Create new exposure object
        const exposure = {
          id: savedExposure.id,
          time: savedExposure.time,
          grade: savedExposure.grade,
          mask: null
        };

        // Convert mask array back to Float32Array if it exists
        if (savedExposure.mask) {
          exposure.mask = new Float32Array(savedExposure.mask);
        }

        // Add to exposures array
        this.exposures.push(exposure);

        // Create exposure UI element
        this.createExposureElement(exposure);
      }

      // Make sure mask canvas is initialized and positioned before selecting exposure
      if (this.negativeImage) {
        this.initMaskCanvas();
        this.positionMaskCanvasToImage();
      }

      // Select first exposure if any exist
      if (this.exposures.length > 0) {
        this.selectExposure(this.exposures[0].id);
      }
      // Process image
      this.requestProcess();
    };
    img.src = project.imageDataURL;
  },

  // File System Access API variables
  directoryHandle: null,
  currentFileHandle: null,

  // Check URL parameters for loading projects or new images
  checkUrlParameters: function() {
    // Get URL parameters
    const urlParams = new URLSearchParams(window.location.search);

    // Check if we're using File System Access API
    if (urlParams.has('fileSystem')) {
      const fileName = sessionStorage.getItem('currentImageFileName');
      if (fileName) {
        this.loadProjectFromFileSystem(fileName);
        return;
      }
    }

    // Check if we're loading a project from localStorage (legacy support)
    if (urlParams.has('projectId')) {
      const projectId = urlParams.get('projectId');
      this.loadProjectFromLocalStorage(projectId);
      return;
    }

    // Check if we're loading a new image from sessionStorage
    if (urlParams.has('newImage') && sessionStorage.getItem('newImageDataURL')) {
      const imageDataURL = sessionStorage.getItem('newImageDataURL');

      // Load the image
      const img = new Image();
      img.onload = () => {
        // Store original image
        this.originalImage = img;

        // Reset current project ID for auto-save (this is a new project)
        this.currentProjectId = null;

        // Convert to B&W negative
        this.convertToNegative(img);

        // Process image
        this.requestProcess();

        // Clear sessionStorage
        sessionStorage.removeItem('newImageDataURL');
      };
      img.src = imageDataURL;
    }
  },

  // Load project from File System Access API
  loadProjectFromFileSystem: async function(fileName) {
    try {
      // Try to get the directory handle
      if (!this.directoryHandle) {
        // Check if we have a saved folder name in localStorage
        const savedFolderName = localStorage.getItem('selectedFolderName');

        // Try to get the directory handle from index.html if it was passed via sessionStorage
        if (sessionStorage.getItem('directoryHandleRequest')) {
          try {
            // This is a special case where we're coming directly from index.html
            // and the directory was just selected, so we don't need to show the picker again
            this.directoryHandle = await window.showDirectoryPicker({
              id: 'darkroom-folder',
              mode: 'readwrite',
              // Skip the picker UI if possible (depends on browser implementation)
              startIn: 'downloads'
            });

            // Clear the request flag
            sessionStorage.removeItem('directoryHandleRequest');
          } catch (error) {
            console.error('Error getting directory handle from session:', error);
            // Fall through to normal picker flow
          }
        }

        // If we still don't have a directory handle, show the picker
        if (!this.directoryHandle) {
          try {
            // Use the File System Access API with a consistent ID
            // This helps the browser remember the permission without showing a picker
            this.directoryHandle = await window.showDirectoryPicker({
              id: 'darkroom-folder',
              mode: 'readwrite'
            });

            // If we have a saved folder name, verify it matches
            if (savedFolderName && this.directoryHandle.name !== savedFolderName) {
              console.log(`Note: Selected folder "${this.directoryHandle.name}" differs from previously saved folder "${savedFolderName}"`);
              // Update the saved folder name
              localStorage.setItem('selectedFolderName', this.directoryHandle.name);
            }
          } catch (error) {
            console.error('Error getting directory handle:', error);
            if (error.name === 'AbortError') {
              // User cancelled the picker
              alert('Please select the folder containing your images.');
              window.location.href = 'index.html';
              return;
            } else {
              // Other error
              alert('Error accessing folder: ' + error.message);
              window.location.href = 'index.html';
              return;
            }
          }
        }
      }

      // Check if we have permission to access the directory
      if (!await ensureDirPermission()) {
        console.warn('Permission to access directory was denied. Please select the folder again.');
        alert('Permission to access folder was denied. Please select the folder again.');
        window.location.href = 'index.html';
        return;
      }

      // Get the file handle for the image
      try {
        this.currentFileHandle = await this.directoryHandle.getFileHandle(fileName);
      } catch (error) {
        console.error('Error getting file handle:', error);
        alert('Could not find the image file. Please select it again from the contact sheet.');
        window.location.href = 'index.html';
        return;
      }

      // Get the file from the handle
      const file = await this.currentFileHandle.getFile();

      // Load the image
      const img = new Image();
      img.onload = async () => {
        // Store original image
        this.originalImage = img;

        // Convert to B&W negative
        this.convertToNegative(img);

        // Try to load associated JSON file with project data
        const jsonFileName = fileName.substring(0, fileName.lastIndexOf('.')) + '.json';
        try {
          const jsonFileHandle = await this.directoryHandle.getFileHandle(jsonFileName);
          const jsonFile = await jsonFileHandle.getFile();
          const jsonText = await jsonFile.text();
          const project = JSON.parse(jsonText);

          // Set paper type
          this.paperType = project.paperType;
          document.getElementById('paper-type').value = project.paperType;
          this.updatePaperInfo();

          // Clear existing exposures
          this.exposures = [];
          document.getElementById('exposures-list').innerHTML = '';

          // Create exposures
          for (let i = 0; i < project.exposures.length; i++) {
            const savedExposure = project.exposures[i];

            // Create new exposure object
            const exposure = {
              id: savedExposure.id,
              time: savedExposure.time,
              grade: savedExposure.grade,
              mask: null
            };

            // Convert mask array back to Float32Array if it exists
            if (savedExposure.mask) {
              exposure.mask = new Float32Array(savedExposure.mask);
            }

            // Add to exposures array
            this.exposures.push(exposure);

            // Create exposure UI element
            this.createExposureElement(exposure);
          }

          // Make sure mask canvas is initialized and positioned before selecting exposure
          if (this.negativeImage) {
            this.initMaskCanvas();
            this.positionMaskCanvasToImage();
          }

          // Select first exposure if any exist
          if (this.exposures.length > 0) {
            this.selectExposure(this.exposures[0].id);
          }
        } catch (error) {
          // No JSON file found or error reading it - start with default settings
          console.log('No project data found or error reading it:', error);

          // Add default exposure
          if (this.exposures.length === 0) {
            this.addExposure();
          }
        }

        // Process image
        this.requestProcess();
      };

      // Create object URL for the file
      img.src = URL.createObjectURL(file);

      // Clean up object URL when done
      img.onload = function() {
        URL.revokeObjectURL(img.src);
      };
    } catch (error) {
      console.error('Error loading project from file system:', error);
      alert('Error loading project: ' + error.message);
    }
  }
};

// Contact Sheet functionality
// File System Access API variables
let directoryHandle = null;
let fileHandles = [];
let currentFileHandle = null;

// Check if File System Access API is supported
const isFileSystemAccessSupported = 'showDirectoryPicker' in window;

// View switching functions
function showContactView() {
  document.getElementById('contact-view').classList.remove('hidden');
  document.getElementById('darkroom-view').classList.remove('active');
}

function showDarkroomView() {
  document.getElementById('contact-view').classList.add('hidden');
  document.getElementById('darkroom-view').classList.add('active');

  // Initialize the darkroom simulator if it hasn't been initialized yet
  if (typeof DarkroomSimulator !== 'undefined' && !DarkroomSimulator.initialized) {
    DarkroomSimulator.init();
    DarkroomSimulator.initialized = true;
  }
}

// Select a folder using File System Access API
async function selectFolder() {
  try {
    if (!isFileSystemAccessSupported) {
      alert('Your browser does not support the File System Access API. Please use Chrome or Edge.');
      return;
    }

    // Show directory picker
    directoryHandle = await window.showDirectoryPicker();

    // Save the directory handle to localStorage and IndexedDB
    try {
      // Store the folder name in localStorage (for UI display)
      localStorage.setItem('selectedFolderName', directoryHandle.name);

      // Persist the handle (so we can reopen without user input next time)
      try {
        await idbSet('directoryHandle', directoryHandle);
      } catch (e) {
        console.warn('Could not persist directory handle:', e);
      }
    } catch (storageError) {
      console.error('Error saving folder to localStorage:', storageError);
    }

    // Scan for JPEG files in the folder
    await scanFolderForImages();
  } catch (error) {
    console.error('Error selecting folder:', error);
    if (error.name !== 'AbortError') {
      alert('Error selecting folder: ' + error.message);
    }
  }
}

// Scan the selected folder for JPEG files
async function scanFolderForImages() {
  if (!directoryHandle) return;

  // Check if we have permission to access the directory
  if (!await ensureDirPermission()) {
    console.warn('Permission to access directory was denied. Please select the folder again.');
    return;
  }

  try {
    fileHandles = [];

    // Iterate through all files in the directory
    for await (const entry of directoryHandle.values()) {
      if (entry.kind === 'file') {
        const name = entry.name.toLowerCase();
        // Check if the file is a JPEG
        if (name.endsWith('.jpg') || name.endsWith('.jpeg')) {
          fileHandles.push(entry);
        }
      }
    }

    console.log(`Found ${fileHandles.length} JPEG files in the folder`);

    // Rebuild the contact sheet with the found images
    SHEETS.forEach(buildSheet);
  } catch (error) {
    console.error('Error scanning folder:', error);
    alert('Error scanning folder: ' + error.message);
  }
}

// Get project data from a JSON file next to the JPEG
async function getProjectDataForImage(fileHandle) {
  try {
    const jsonFileName = fileHandle.name.substring(0, fileHandle.name.lastIndexOf('.')) + '.json';

    // Try to get the JSON file with the same name
    try {
      const jsonFileHandle = await directoryHandle.getFileHandle(jsonFileName);
      const file = await jsonFileHandle.getFile();
      const text = await file.text();
      return JSON.parse(text);
    } catch (error) {
      // JSON file doesn't exist or can't be read, which is fine for new images
      return null;
    }
  } catch (error) {
    console.error('Error getting project data:', error);
    return null;
  }
}

// Open project in darkroom view
async function openProject(fileHandle) {
  try {
    // Check if we have permission to access the directory
    if (!await ensureDirPermission()) {
      console.warn('Permission to access directory was denied. Please select the folder again.');
      return;
    }

    // Store the current file handle
    currentFileHandle = fileHandle;

    // Get the file from the handle
    const file = await fileHandle.getFile();

    // Load the image
    const img = new Image();

    // Create object URL for the file
    const objectUrl = URL.createObjectURL(file);

    img.onload = async () => {
      // Clean up object URL when done
      URL.revokeObjectURL(objectUrl);

      // Resize the image if needed
      const processedImg = resizeImageIfNeeded(img);

      // Store the image in DarkroomSimulator
      DarkroomSimulator.directoryHandle = directoryHandle;
      DarkroomSimulator.currentFileHandle = currentFileHandle;
      DarkroomSimulator.originalImage = processedImg;

      // Convert to B&W negative
      DarkroomSimulator.convertToNegative(processedImg);

      // Try to load associated JSON file with project data
      const jsonFileName = fileHandle.name.substring(0, fileHandle.name.lastIndexOf('.')) + '.json';
      try {
        const jsonFileHandle = await directoryHandle.getFileHandle(jsonFileName);
        const jsonFile = await jsonFileHandle.getFile();
        const jsonText = await jsonFile.text();
        const project = JSON.parse(jsonText);

        // Set paper type
        DarkroomSimulator.paperType = project.paperType;
        document.getElementById('paper-type').value = project.paperType;
        DarkroomSimulator.updatePaperInfo();

        // Clear existing exposures
        DarkroomSimulator.exposures = [];
        document.getElementById('exposures-list').innerHTML = '';

        // Create exposures
        for (let i = 0; i < project.exposures.length; i++) {
          const savedExposure = project.exposures[i];

          // Create new exposure object
          const exposure = {
            id: savedExposure.id,
            time: savedExposure.time,
            grade: savedExposure.grade,
            mask: null
          };

          // Convert mask array back to Float32Array if it exists
          if (savedExposure.mask) {
            exposure.mask = new Float32Array(savedExposure.mask);
          }

          // Add to exposures array
          DarkroomSimulator.exposures.push(exposure);

          // Create exposure UI element
          DarkroomSimulator.createExposureElement(exposure);
        }

        // Select first exposure if any exist
        if (DarkroomSimulator.exposures.length > 0) {
          DarkroomSimulator.selectExposure(DarkroomSimulator.exposures[0].id);
        }
      } catch (error) {
        // No JSON file found or error reading it - start with default settings
        console.log('No project data found or error reading it:', error);

        // Add default exposure
        if (DarkroomSimulator.exposures.length === 0) {
          DarkroomSimulator.addExposure();
        }
      }

      // Process image
      DarkroomSimulator.requestProcess();

      // Switch to darkroom view
      showDarkroomView();
    };

    // Set the image source to load it
    img.src = objectUrl;
  } catch (error) {
    console.error('Error opening project:', error);
    alert('Error opening file: ' + error.message);
  }
}

// Handle file selection for new project
async function handleFileSelection(fileHandle) {
  try {
    // Store the current file handle
    currentFileHandle = fileHandle;

    // Get the file from the handle
    const file = await fileHandle.getFile();

    // Process the file directly without using sessionStorage
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      // Clean up object URL
      URL.revokeObjectURL(objectUrl);

      // Resize the image if needed
      const processedImg = resizeImageIfNeeded(img);

      // Store the image in DarkroomSimulator
      DarkroomSimulator.directoryHandle = directoryHandle;
      DarkroomSimulator.currentFileHandle = currentFileHandle;
      DarkroomSimulator.originalImage = processedImg;

      // Reset current project ID for auto-save (this is a new project)
      DarkroomSimulator.currentProjectId = null;

      // Convert to B&W negative
      DarkroomSimulator.convertToNegative(processedImg);

      // Add default exposure if needed
      if (DarkroomSimulator.exposures.length === 0) {
        DarkroomSimulator.addExposure();
      }

      // Process image
      DarkroomSimulator.requestProcess();

      // Switch to darkroom view
      showDarkroomView();
    };

    // Set the image source to load it
    img.src = objectUrl;
  } catch (error) {
    console.error('Error handling file selection:', error);
    alert('Error opening file: ' + error.message);
  }
}

// Helper function to resize an image if needed
function resizeImageIfNeeded(img) {
  // Check if image has valid dimensions
  if (!img.width || !img.height) {
    console.error('Image has invalid dimensions in resizeImageIfNeeded:', img.width, 'x', img.height);
    return img; // Return original image to prevent further errors
  }

  // Check if the image needs resizing
  const maxDimension = 1200;
  if (img.width <= maxDimension && img.height <= maxDimension) {
    return img; // No resizing needed
  }

  // Create canvas for resizing
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  // Calculate new dimensions
  let width = img.width;
  let height = img.height;

  if (width > height) {
    height = Math.round(height * (maxDimension / width));
    width = maxDimension;
  } else {
    width = Math.round(width * (maxDimension / height));
    height = maxDimension;
  }

  // Resize image
  canvas.width = width;
  canvas.height = height;
  ctx.drawImage(img, 0, 0, width, height);

  // Create a new image with the resized dimensions
  const resizedImg = new Image();

  // Set up onload handler to ensure the image is fully loaded
  resizedImg.onload = function() {
    console.log('Resized image loaded with dimensions:', resizedImg.width, 'x', resizedImg.height);
  };

  // Set the source after setting up the onload handler
  resizedImg.src = canvas.toDataURL('image/jpeg', 0.85);

  // Return the original image to ensure we have valid dimensions
  // The defensive check in convertToNegative will prevent errors
  return img;
}

// ====== Build a grid of tiles from a single frame image ======
const FRAME_SRC = 'frame-tile.png';        // your single-frame PNG/JPG
const SHEETS = ['sheetA','sheetB'];        // ids of grids to populate

// Load once to set accurate aspect ratio for tiles
const tileImg = new Image();
tileImg.src = FRAME_SRC;
tileImg.onload = () => {
  SHEETS.forEach(buildSheet);
};
tileImg.onerror = () => {
  // Fallback if image fails; still build sheets
  SHEETS.forEach(buildSheet);
};

async function buildSheet(gridId) {
  const grid = document.getElementById(gridId);
  if(!grid) return;

  // Clear the grid first
  grid.innerHTML = '';

  if (directoryHandle && fileHandles.length > 0) {
    // Calculate the number of columns based on the number of images
    // We'll use a maximum of 5 columns
    const cols = Math.min(5, fileHandles.length);
    // Calculate the number of rows needed to display all images
    const rows = Math.ceil(fileHandles.length / cols);

    grid.style.setProperty('--rows', rows);
    grid.style.setProperty('--cols', cols);

    // Create frames for existing images from the folder
    for (let i = 0; i < fileHandles.length; i++) {
      const fileHandle = fileHandles[i];
      const frame = await createFrameFromFileHandle(fileHandle, i);
      grid.appendChild(frame);
    }
  } else {
    // If no folder is selected, show only a single frame with the folder prompt
    grid.style.setProperty('--rows', 1);
    grid.style.setProperty('--cols', 1);
    grid.classList.add('single-frame'); // Add class for single frame

    const frame = createFolderPromptFrame();
    grid.appendChild(frame);
  }
}

// Create a frame that prompts the user to select a folder
function createFolderPromptFrame() {
  const frame = document.createElement('div');
  frame.className = 'frame is-empty';

  // Frame background (tile)
  frame.style.backgroundImage = `url("${FRAME_SRC}")`;

  // Inner window + hit area
  const windowEl = document.createElement('div');
  windowEl.className = 'window';

  const hit = document.createElement('button');
  hit.type = 'button';
  hit.className = 'hit';
  hit.style.display = 'flex';
  hit.style.alignItems = 'center';
  hit.style.justifyContent = 'center';
  hit.innerHTML = '<div style="text-align: center; padding: 10px; color: white;">Select a folder to view images</div>';

  // Click handler
  hit.addEventListener('click', (ev) => {
    ev.stopPropagation();
    selectFolder();
  });

  windowEl.appendChild(hit);
  frame.appendChild(windowEl);
  return frame;
}

// Create a frame from a file handle
async function createFrameFromFileHandle(fileHandle, index) {
  const frame = document.createElement('div');
  frame.className = 'frame is-existing';

  // Slight random rotation for wax outline only
  frame.style.setProperty('--wax-rot', `${(Math.random()*2-1)*0.5}deg`);

  // random tiling
  const x = Math.floor(Math.random() * 100) + 'px';
  document.body.style.setProperty('--bg-offset-x', x);

  // Frame background (tile)
  frame.style.backgroundImage = `url("${FRAME_SRC}")`;

  // Inner window + hit area
  const windowEl = document.createElement('div');
  windowEl.className = 'window';

  const hit = document.createElement('button');
  hit.type = 'button';
  hit.className = 'hit';
  hit.dataset.index = index;

  try {
    // Get the file from the handle
    const file = await fileHandle.getFile();

    // Create an image element
    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    img.alt = file.name;

    // Check if image is portrait and rotate if needed
    img.onload = function() {
      if (img.naturalHeight > img.naturalWidth) {
        // Portrait image - add portrait class for rotation
        img.classList.add('portrait');
      }
      // Revoke the object URL to free memory
      URL.revokeObjectURL(img.src);
    };

    hit.appendChild(img);

    // Store file handle for click handler
    hit.dataset.fileName = fileHandle.name;

    // Add click handler
    hit.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openProject(fileHandle);
    });
  } catch (error) {
    console.error('Error creating frame from file handle:', error);
    hit.textContent = 'Error loading image';
  }

  windowEl.appendChild(hit);
  frame.appendChild(windowEl);
  return frame;
}

// Create an empty frame
function createEmptyFrame(index) {
  const frame = document.createElement('div');
  frame.className = 'frame is-empty';

  // Slight random rotation for wax outline only
  frame.style.setProperty('--wax-rot', `${(Math.random()*2-1)*0.5}deg`);

  // Frame background (tile)
  frame.style.backgroundImage = `url("${FRAME_SRC}")`;

  // Inner window + hit area
  const windowEl = document.createElement('div');
  windowEl.className = 'window';

  const hit = document.createElement('button');
  hit.type = 'button';
  hit.className = 'hit';
  hit.dataset.index = index;

  // Click handler for empty frames
  hit.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (directoryHandle) {
      // If a folder is selected, prompt to select a new image
      alert('Please select images from your file system and place them in the selected folder.');
    } else {
      // If no folder is selected, prompt to select a folder
      selectFolder();
    }
  });

  windowEl.appendChild(hit);
  frame.appendChild(windowEl);
  return frame;
}

// Function to check and request permission for a directory handle
async function ensureDirPermission() {
  if (!directoryHandle) return false;
  let p = await directoryHandle.queryPermission({ mode: 'readwrite' });
  if (p === 'prompt') p = await directoryHandle.requestPermission({ mode: 'readwrite' });
  return p === 'granted';
}

// Restore the directory handle from IndexedDB
async function restoreDirectoryHandle() {
  try {
    const saved = await idbGet('directoryHandle');
    if (!saved) return false;

    // Check permission
    let perm = await saved.queryPermission({ mode: 'readwrite' });
    if (perm === 'prompt') {
      perm = await saved.requestPermission({ mode: 'readwrite' });
    }
    if (perm !== 'granted') return false;

    directoryHandle = saved;

    // Update UI with folder name
    const folderName = directoryHandle.name;
    localStorage.setItem('selectedFolderName', folderName);

    // Scan for JPEG files in the folder
    await scanFolderForImages();
    return true;
  } catch (e) {
    console.warn('restoreDirectoryHandle failed:', e);
    return false;
  }
}

// Initialize the application when the DOM is loaded
document.addEventListener('DOMContentLoaded', async function() {
  DarkroomSimulator.init();
  DarkroomSimulator.initialized = true;

  // Set up back button in darkroom view
  document.getElementById('back').addEventListener('click', async () => {
    showContactView();

    // If we have a directory handle, scan for images to refresh the contact sheet
    if (directoryHandle) {
      await scanFolderForImages();
    }
  });

  // Check if File System Access API is supported
  if (!isFileSystemAccessSupported) {
    console.warn('Your browser does not support the File System Access API. Please use Chrome or Edge.');
    SHEETS.forEach(buildSheet);
    return;
  }

  // Try to restore previously authorized handle (no picker)
  const restored = await restoreDirectoryHandle();
  if (!restored) {
    // No handle or permission — build empty grids and wait for user to click "Select Folder"
    SHEETS.forEach(buildSheet);
    const last = localStorage.getItem('selectedFolderName');
    if (last) {
      console.log(`Last used folder: ${last} (click to reopen)`);
    }
  }
});
