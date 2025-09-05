/**
 * Digital Darkroom Simulator
 * Darkroom functionality for simulating photographic printing process
 */

// GPU Engine implementation
class GPUEngine {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = null;
    this.prog = null;
    this.maxExposures = 12; // same as your gradeParams length
    this.textures = { trans: null, lut: null, masks: [] };
    this.buffers = {};
    this.size = { w: 0, h: 0 };
    this.loc = {};
  }

  available() {
    try {
      const gl = this.canvas.getContext('webgl2', { 
        premultipliedAlpha: false,
        preserveDrawingBuffer: true
      });
      if (!gl) return false;
      const ok = !!gl.getExtension('EXT_color_buffer_float'); // nice to have
      this.gl = gl;
      return true;
    } catch {
      return false;
    }
  }

  _compile(type, src) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(sh) || 'Shader compile failed');
    }
    return sh;
  }

  _link(vsSrc, fsSrc) {
    const gl = this.gl;
    const vs = this._compile(gl.VERTEX_SHADER, vsSrc);
    const fs = this._compile(gl.FRAGMENT_SHADER, fsSrc);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog) || 'Program link failed');
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return prog;
  }

  initProgram() {
    const vs = `#version 300 es
    precision highp float;
    const vec2 pos[4]=vec2[4](vec2(-1.,-1.),vec2(1.,-1.),vec2(-1.,1.),vec2(1.,1.));
    const vec2 uv_[4]=vec2[4](vec2(0.,1.),vec2(1.,1.),vec2(0.,0.),vec2(1.,0.));
    out vec2 vUV;
    void main(){
      vUV = uv_[gl_VertexID];
      gl_Position = vec4(pos[gl_VertexID],0.,1.);
    }`;

    const fs = `#version 300 es
    precision highp float;

    // Inputs
    in vec2 vUV;
    out vec4 outColor;

    // Textures
    uniform sampler2D uTrans;        // R8: transmittance in [0..1] (your inverted grayscale)
    uniform sampler2D uSigmoidLUT;   // 1D LUT baked into 2D (width=N, height=1)

    // Up to MAX exposures worth of mask textures (alpha channel used). Missing masks are 0.
    #define MAX_EXPOSURES 12
    uniform sampler2D uMasks[MAX_EXPOSURES];

    // Paper params
    uniform float uDmin;
    uniform float uDmax;
    uniform vec3  uHi;  // highlights tone multipliers (r,g,b)
    uniform vec3  uMid; // midtones
    uniform vec3  uSh;  // shadows

    // LUT params
    uniform float uLUTLo;
    uniform float uLUTStep;
    uniform float uLUTLenMinus1;

    // Exposure constants per exposure (parallel arrays)
    uniform int   uExposureCount;
    uniform float uLogT[MAX_EXPOSURES];
    uniform float uK[MAX_EXPOSURES];
    uniform float uE0[MAX_EXPOSURES];
    uniform int   uHasMask[MAX_EXPOSURES]; // 1=has mask, 0=no

    // Helpers
    float log10_(float x){ return log(x) / 2.302585092994046; } // ln10
    float fetchSigmoid(float x){
      // map x -> LUT index
      float idx = (x - uLUTLo) / uLUTStep;
      idx = clamp(idx, 0.0, uLUTLenMinus1);
      float u = (idx + 0.5) / (uLUTLenMinus1 + 1.0);
      return texture(uSigmoidLUT, vec2(u, 0.5)).r;
    }

    void main(){
      float trans = texture(uTrans, vUV).r;                 // 0..1
      float logTrans = log10_(max(1e-6, trans));
      float span = uDmax - uDmin;
      float totalDensity = uDmin;

      // If we have at least one exposure, ensure we have a visible image
      if (uExposureCount > 0) {
        // Process all exposures
        for (int e=0; e<uExposureCount; ++e){

          float maskMul = 1.0;
          if (uHasMask[e] == 1){
            // WebGL requires constant indices for samplers, so we need to use if/else
            float a = 0.0;
            if (e == 0) a = texture(uMasks[0], vUV).a;
            else if (e == 1) a = texture(uMasks[1], vUV).a;
            else if (e == 2) a = texture(uMasks[2], vUV).a;
            else if (e == 3) a = texture(uMasks[3], vUV).a;
            else if (e == 4) a = texture(uMasks[4], vUV).a;
            else if (e == 5) a = texture(uMasks[5], vUV).a;
            else if (e == 6) a = texture(uMasks[6], vUV).a;
            else if (e == 7) a = texture(uMasks[7], vUV).a;
            else if (e == 8) a = texture(uMasks[8], vUV).a;
            else if (e == 9) a = texture(uMasks[9], vUV).a;
            else if (e == 10) a = texture(uMasks[10], vUV).a;
            else if (e == 11) a = texture(uMasks[11], vUV).a;
            maskMul = 1.0 - a;                    // your CPU logic
          }

          float logE = uLogT[e] + logTrans;
          if (maskMul < 1.0) logE += log10_(max(1e-6, maskMul));

          float x = uK[e] * (logE - uE0[e]);
          float s = fetchSigmoid(x);

          float density = uDmin + span * s;
          float extra = density - uDmin;
          totalDensity += max(0.0, extra); // Always add, but ensure we don't subtract
        }
      }

      totalDensity = min(totalDensity, uDmax);

      // reflectance = 10^(-D)
      float reflectance = exp(-totalDensity * 2.302585092994046);

      vec3 col;
      if (reflectance < 0.5) {
        float t = reflectance * 2.0;
        col = (uSh * (1.0 - t) + uMid * t) * reflectance;
      } else {
        float t = (reflectance - 0.5) * 2.0;
        col = (uMid * (1.0 - t) + uHi * t) * reflectance;
      }

      outColor = vec4(col, 1.0);
    }`;

    this.prog = this._link(vs, fs);
    const gl = this.gl;
    gl.useProgram(this.prog);

    // Cache uniform locations
    const U = (n) => gl.getUniformLocation(this.prog, n);
    this.loc = {
      uTrans: U('uTrans'),
      uSigmoidLUT: U('uSigmoidLUT'),
      uDmin: U('uDmin'),
      uDmax: U('uDmax'),
      uHi: U('uHi'),
      uMid: U('uMid'),
      uSh: U('uSh'),
      uLUTLo: U('uLUTLo'),
      uLUTStep: U('uLUTStep'),
      uLUTLenMinus1: U('uLUTLenMinus1'),
      uExposureCount: U('uExposureCount'),
      uLogT: U('uLogT'),
      uK: U('uK'),
      uE0: U('uE0'),
      uHasMask: U('uHasMask')
    };

    // Pre-bind sampler units
    gl.uniform1i(this.loc.uTrans, 0);
    gl.uniform1i(this.loc.uSigmoidLUT, 1);
    for (let i = 0; i < this.maxExposures; i++) {
      const loc = gl.getUniformLocation(this.prog, `uMasks[${i}]`);
      if (loc) gl.uniform1i(loc, 2 + i);
    }

    // Fullscreen triangle via gl_VertexID (no VAO needed)
  }

  _createTex(w, h, opts = {}) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, opts.filter || gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, opts.filter || gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (opts.data) {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, opts.internal || gl.R8, w, h, 0, opts.format || gl.RED, opts.type || gl.UNSIGNED_BYTE, opts.data);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, opts.internal || gl.R8, w, h, 0, opts.format || gl.RED, opts.type || gl.UNSIGNED_BYTE, null);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  uploadTransmittanceFromImageData(imageData) {
    // imageData is your grayscale inverted negative; take red as trans
    const { width: w, height: h, data } = imageData;
    this.size = { w, h };

    // Convert 0..255 to 0..255 (byte) in RED channel texture; shader reads normalized
    // We can just keep the R channel as-is from imageData (already inverted grayscale).
    // Build a compact R8 array.
    const r8 = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      r8[j] = data[i]; // red channel
    }

    const gl = this.gl;
    this.textures.trans = this._createTex(w, h, {
      filter: gl.NEAREST,
      internal: gl.R8,
      format: gl.RED,
      type: gl.UNSIGNED_BYTE,
      data: r8
    });

    // Resize draw buffer to match
    this.canvas.width = w;
    this.canvas.height = h;
    gl.viewport(0, 0, w, h);
  }

  uploadLUT(sigmoidLUT) {
    const { lut, lo, hi, step } = sigmoidLUT;
    const gl = this.gl;
    // Put LUT in a 1xN texture (use RGBA8, store in R)
    const N = lut.length;
    const bytes = new Uint8Array(N);
    for (let i = 0; i < N; i++) bytes[i] = Math.round(lut[i] * 255);

    this.textures.lut = this._createTex(N, 1, {
      filter: gl.LINEAR, // smooth lookups
      internal: gl.R8,
      format: gl.RED,
      type: gl.UNSIGNED_BYTE,
      data: bytes
    });

    gl.useProgram(this.prog);
    gl.uniform1f(this.loc.uLUTLo, lo);
    gl.uniform1f(this.loc.uLUTStep, step);
    gl.uniform1f(this.loc.uLUTLenMinus1, N - 1);
  }

  uploadMasks(exposures, w, h) {
    const gl = this.gl;
    // Ensure we have MAX slots
    while (this.textures.masks.length < this.maxExposures) {
      this.textures.masks.push(this._createTex(w, h, {
        filter: gl.NEAREST,
        internal: gl.RGBA8,
        format: gl.RGBA,
        type: gl.UNSIGNED_BYTE
      }));
    }

    // Calculate the number of exposures to process (same as in render method)
    const n = Math.min(exposures.length, this.maxExposures);

    // Upload or clear per exposure, limiting to n exposures
    for (let i = 0; i < n; i++) {
      const exp = exposures[i];
      gl.activeTexture(gl.TEXTURE2 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.textures.masks[i]);
      if (exp.maskData && exp.maskData.data && exp.maskData.width && exp.maskData.height) {
        // Ensure we have valid mask data before uploading
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

        // Create a temporary canvas to ensure data is properly formatted
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = exp.maskData.width;
        tempCanvas.height = exp.maskData.height;
        const tempCtx = tempCanvas.getContext('2d');
        const tempImgData = tempCtx.createImageData(exp.maskData.width, exp.maskData.height);
        tempImgData.data.set(exp.maskData.data);
        tempCtx.putImageData(tempImgData, 0, 0);

        // Use the canvas as the texture source instead of raw data
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, tempCanvas);
      } else {
        // clear to zero alpha
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      }
    }

    gl.activeTexture(gl.TEXTURE0);
  }

  render(paper, exposures, sigmoidLUT) {
    const gl = this.gl;
    if (!gl || !this.prog) return;

    gl.useProgram(this.prog);

    // Bind textures
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.trans);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.lut);

    // Upload uniforms for paper
    gl.uniform1f(this.loc.uDmin, paper.Dmin);
    gl.uniform1f(this.loc.uDmax, paper.Dmax);
    const { highlights, midtones, shadows } = paper.colorTone;
    gl.uniform3f(this.loc.uHi, highlights.r, highlights.g, highlights.b);
    gl.uniform3f(this.loc.uMid, midtones.r, midtones.g, midtones.b);
    gl.uniform3f(this.loc.uSh, shadows.r, shadows.g, shadows.b);

    // Exposure constants
    const n = Math.min(exposures.length, this.maxExposures);
    const logT = new Float32Array(this.maxExposures);
    const kArr = new Float32Array(this.maxExposures);
    const e0Arr = new Float32Array(this.maxExposures);
    const hasMask = new Int32Array(this.maxExposures);

    for (let i = 0; i < n; i++) {
      const grade = parseInt(exposures[i].grade, 10);
      const timeSec = parseFloat(exposures[i].time);
      const p = paper.gradeParams[grade];
      logT[i] = Math.log10(Math.max(1e-6, timeSec));
      kArr[i] = p.k;
      e0Arr[i] = (function midtoneLogEForGrade() {
        const baseE = paper.baseExposure;
        const Eshift = Math.pow(2, p.speedShiftStops);
        return Math.log10(baseE * Eshift);
      }());
      hasMask[i] = exposures[i].maskData ? 1 : 0;
    }

    gl.uniform1i(this.loc.uExposureCount, n);
    gl.uniform1fv(this.loc.uLogT, logT);
    gl.uniform1fv(this.loc.uK, kArr);
    gl.uniform1fv(this.loc.uE0, e0Arr);
    gl.uniform1iv(this.loc.uHasMask, hasMask);

    // Bind mask textures
    this.uploadMasks(exposures, this.size.w, this.size.h);

    // Draw 2 triangles (using gl_VertexID trick)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

// Global variables for file handling
let directoryHandle = null;
let currentFileHandle = null;

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
  const baseE = paper.baseExposure;              // arbitrary "exposure units"
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

// ADD: once-per-app LUT for a logistic sigmoid over a wide range
function makeSigmoidLUT() {
  const N = 4096, lo = -12, hi = 12;
  const step = (hi - lo) / (N - 1);
  const lut = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = lo + i * step;
    lut[i] = 1 / (1 + Math.exp(-x));
  }
  return { lut, lo, hi, step };
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
  initialized: false,
  saveWarningShown: false, // Track if save warning has been shown
  saveErrorShown: false, // Track if save error has been shown
  loadingProjectData: false, // Track if project data is being loaded

  // History management for undo/redo
  history: [],
  redoStack: [],
  maxHistoryLength: 20, // Maximum number of states to keep in history

  // GPU acceleration
  gpu: null,

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
  brushFlow: 0.01,  // lower = gentler build-up

  // --- FAST PATH state ---
  workCanvas: null,
  workCtx: null,
  resultCanvasEl: null,  // <canvas id="result-canvas"> (preferred)
  resultImageEl: null,   // <img id="result-image"> (fallback if canvas missing)


  sigmoidLUT: null,      // { lut, lo, hi, step }
  _processTimer: null,   // debounce for processImage
  _saveTimer: null,      // throttle/debounce for saving
  _dirtySinceSave: false, // set true whenever user edits something

  // ADD to state:
  _resultImageData: null,
  _brushCanvas: null,
  _brushStamp: null,
  _maskRect: null,
  _setupMaskRAF: null,
  _setupMaskDebounce: null,
  _setupMaskLastExposureId: null,

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
    if (!this.sigmoidLUT) this.sigmoidLUT = makeSigmoidLUT();

    // Set up GPU engine
    if (this.resultCanvasEl) {
      const engine = new GPUEngine(this.resultCanvasEl);
      if (engine.available()) {
        engine.initProgram();
        this.gpu = engine;
      } else {
        console.warn('WebGL2 not available. This application requires WebGL2 support.');
        alert('This application requires WebGL2 support, which is not available in your browser.');
      }
    }

    this.negativeImageEl = document.getElementById('negative-image');
    this.setupEventListeners();
    if (this.exposures.length === 0 && !this.loadingProjectData) this.addExposure();

    // Check for URL parameters
    this.checkUrlParameters();

    // Set initialized flag
    this.initialized = true;

    // Initialize undo/redo button states
    this.updateUndoRedoButtons();
  },

  // History management functions
  saveState: function() {
    // Create a deep copy of the exposures array
    const exposuresCopy = this.exposures.map(exposure => {
      // Create a deep copy of the exposure object
      const exposureCopy = {
        id: exposure.id,
        time: exposure.time,
        grade: exposure.grade
      };

      // If the exposure has mask data, create a deep copy of it
      if (exposure.maskData) {
        exposureCopy.maskData = new ImageData(
          new Uint8ClampedArray(exposure.maskData.data),
          exposure.maskData.width,
          exposure.maskData.height
        );
      }

      return exposureCopy;
    });

    // Save the state
    this.history.push({
      exposures: exposuresCopy,
      paperType: this.paperType,
      selectedExposureId: this.selectedExposureId
    });

    // Limit history length
    if (this.history.length > this.maxHistoryLength) {
      this.history.shift();
    }

    // Clear redo stack when a new state is saved
    this.redoStack = [];

    // Update undo/redo button states
    this.updateUndoRedoButtons();
  },

  undo: function() {
    if (this.history.length === 0) return;

    // Get the current state before undoing
    const currentState = {
      exposures: this.exposures.map(exposure => {
        const exposureCopy = {
          id: exposure.id,
          time: exposure.time,
          grade: exposure.grade
        };

        if (exposure.maskData) {
          exposureCopy.maskData = new ImageData(
            new Uint8ClampedArray(exposure.maskData.data),
            exposure.maskData.width,
            exposure.maskData.height
          );
        }

        return exposureCopy;
      }),
      paperType: this.paperType,
      selectedExposureId: this.selectedExposureId
    };

    // Add current state to redo stack
    this.redoStack.push(currentState);

    // Get the previous state
    const previousState = this.history.pop();

    // Restore paper type
    this.paperType = previousState.paperType;
    const paperTypeSelect = document.getElementById('paper-type');
    if (paperTypeSelect) {
      paperTypeSelect.value = this.paperType;
    }

    // Clear the exposures list UI
    const exposuresList = document.getElementById('exposures-list');
    if (exposuresList) {
      exposuresList.innerHTML = '';
    }

    // Restore the exposures array
    this.exposures = previousState.exposures.map(exposure => {
      const exposureCopy = {
        id: exposure.id,
        time: exposure.time,
        grade: exposure.grade
      };

      if (exposure.maskData) {
        exposureCopy.maskData = new ImageData(
          new Uint8ClampedArray(exposure.maskData.data),
          exposure.maskData.width,
          exposure.maskData.height
        );
      }

      return exposureCopy;
    });

    // Rebuild the exposures UI
    this.exposures.forEach(exposure => {
      const exposureTemplate = document.querySelector('.exposure-template').cloneNode(true);
      const exposureItem = exposureTemplate.querySelector('.exposure-item');

      exposureItem.setAttribute('data-exposure-id', exposure.id);
      exposureItem.classList.remove('hidden');

      // Set the initial values for time and grade
      const timeSelect = exposureItem.querySelector('.exposure-time');
      if (timeSelect) {
        timeSelect.value = exposure.time;
      }

      const gradeSelect = exposureItem.querySelector('.exposure-grade');
      if (gradeSelect) {
        gradeSelect.value = exposure.grade;
      }

      const gradeDisplay = exposureItem.querySelector('.grade-display');
      if (gradeDisplay) {
        // Remove all grade classes
        for (let i = 0; i <= 11; i++) {
          gradeDisplay.classList.remove(`grade-${i}`);
        }
        // Add the correct grade class
        gradeDisplay.classList.add(`grade-${exposure.grade}`);

        // Set the text content based on the grade
        const gradeOption = document.querySelector(`.grade-option[data-value="${exposure.grade}"]`);
        if (gradeOption) {
          gradeDisplay.textContent = gradeOption.textContent;
        }
      }

      // Add event listeners to the exposure controls
      this.setupExposureControls(exposureItem, exposure.id);

      // Add to the list
      exposuresList.appendChild(exposureItem);

      // Initialize the dodge mask preview
      const previewCanvas = exposureItem.querySelector('.dodge-mask-preview');
      if (previewCanvas && exposure.maskData) {
        this.updateDodgeMaskPreview(previewCanvas, exposure.maskData);
      }
    });

    // Update button states for all exposures
    this.updateAllExposureButtons();

    // Select the previously selected exposure
    if (previousState.selectedExposureId) {
      this.selectExposure(previousState.selectedExposureId);
    } else if (this.exposures.length > 0) {
      this.selectExposure(this.exposures[0].id);
    }

    // Process the image with the updated exposures
    this.markDirty();
    this.requestProcess();

    // Update undo/redo button states
    this.updateUndoRedoButtons();
  },

  redo: function() {
    if (this.redoStack.length === 0) return;

    // Get the current state before redoing
    const currentState = {
      exposures: this.exposures.map(exposure => {
        const exposureCopy = {
          id: exposure.id,
          time: exposure.time,
          grade: exposure.grade
        };

        if (exposure.maskData) {
          exposureCopy.maskData = new ImageData(
            new Uint8ClampedArray(exposure.maskData.data),
            exposure.maskData.width,
            exposure.maskData.height
          );
        }

        return exposureCopy;
      }),
      paperType: this.paperType,
      selectedExposureId: this.selectedExposureId
    };

    // Add current state to history stack
    this.history.push(currentState);

    // Get the next state
    const nextState = this.redoStack.pop();

    // Restore paper type
    this.paperType = nextState.paperType;
    const paperTypeSelect = document.getElementById('paper-type');
    if (paperTypeSelect) {
      paperTypeSelect.value = this.paperType;
    }

    // Clear the exposures list UI
    const exposuresList = document.getElementById('exposures-list');
    if (exposuresList) {
      exposuresList.innerHTML = '';
    }

    // Restore the exposures array
    this.exposures = nextState.exposures.map(exposure => {
      const exposureCopy = {
        id: exposure.id,
        time: exposure.time,
        grade: exposure.grade
      };

      if (exposure.maskData) {
        exposureCopy.maskData = new ImageData(
          new Uint8ClampedArray(exposure.maskData.data),
          exposure.maskData.width,
          exposure.maskData.height
        );
      }

      return exposureCopy;
    });

    // Rebuild the exposures UI
    this.exposures.forEach(exposure => {
      const exposureTemplate = document.querySelector('.exposure-template').cloneNode(true);
      const exposureItem = exposureTemplate.querySelector('.exposure-item');

      exposureItem.setAttribute('data-exposure-id', exposure.id);
      exposureItem.classList.remove('hidden');

      // Set the initial values for time and grade
      const timeSelect = exposureItem.querySelector('.exposure-time');
      if (timeSelect) {
        timeSelect.value = exposure.time;
      }

      const gradeSelect = exposureItem.querySelector('.exposure-grade');
      if (gradeSelect) {
        gradeSelect.value = exposure.grade;
      }

      const gradeDisplay = exposureItem.querySelector('.grade-display');
      if (gradeDisplay) {
        // Remove all grade classes
        for (let i = 0; i <= 11; i++) {
          gradeDisplay.classList.remove(`grade-${i}`);
        }
        // Add the correct grade class
        gradeDisplay.classList.add(`grade-${exposure.grade}`);

        // Set the text content based on the grade
        const gradeOption = document.querySelector(`.grade-option[data-value="${exposure.grade}"]`);
        if (gradeOption) {
          gradeDisplay.textContent = gradeOption.textContent;
        }
      }

      // Add event listeners to the exposure controls
      this.setupExposureControls(exposureItem, exposure.id);

      // Add to the list
      exposuresList.appendChild(exposureItem);

      // Initialize the dodge mask preview
      const previewCanvas = exposureItem.querySelector('.dodge-mask-preview');
      if (previewCanvas && exposure.maskData) {
        this.updateDodgeMaskPreview(previewCanvas, exposure.maskData);
      }
    });

    // Update button states for all exposures
    this.updateAllExposureButtons();

    // Select the previously selected exposure
    if (nextState.selectedExposureId) {
      this.selectExposure(nextState.selectedExposureId);
    } else if (this.exposures.length > 0) {
      this.selectExposure(this.exposures[0].id);
    }

    // Process the image with the updated exposures
    this.markDirty();
    this.requestProcess();

    // Update undo/redo button states
    this.updateUndoRedoButtons();
  },

  updateUndoRedoButtons: function() {
    const undoButton = document.getElementById('undo');
    const redoButton = document.getElementById('redo');

    if (undoButton) {
      undoButton.disabled = this.history.length === 0;
      undoButton.classList.toggle('disabled', this.history.length === 0);
    }

    if (redoButton) {
      redoButton.disabled = this.redoStack.length === 0;
      redoButton.classList.toggle('disabled', this.redoStack.length === 0);
    }
  },

  // Set up event listeners
  setupEventListeners: function() {
    // Back button
    document.getElementById('back').addEventListener('click', () => {
      // Navigate back to index.html (contact sheet)
      window.location.href = 'index.html';
    });

    // Undo button
    document.getElementById('undo').addEventListener('click', () => {
      this.undo();
    });

    // Redo button
    document.getElementById('redo').addEventListener('click', () => {
      this.redo();
    });

    // Paper selection
    document.getElementById('paper-type').addEventListener('change', (e) => {
      // Save state before changing paper type
      this.saveState();

      this.paperType = e.target.value;
      // Automatically process image when paper type changes
      if (this.negativeImage) {
        this.markDirty();               // ADD
        this.requestProcess();
      }
    });

    // Add exposure button
    document.getElementById('add-exposure').addEventListener('click', () => {
      // Save state before adding exposure
      this.saveState();
      this.addExposure();
    });

    // Process image is now automatic when exposures or paper change

    // Mask tool buttons
    document.getElementById('dodge-tool').addEventListener('click', () => {
      this.activeTool = 'dodge';
      this.isMaskToolActive = true;
      this.updateToolButtons();
      this.makeBrushStamp(); // ADD
    });

    document.getElementById('erase-tool').addEventListener('click', () => {
      this.activeTool = 'erase';
      this.isMaskToolActive = true;
      this.updateToolButtons();
      this.makeBrushStamp(); // ADD
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

      this.makeBrushStamp(); // ADD
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

      this.makeBrushStamp(); // ADD
    });

    // Window resize handler
    window.addEventListener('resize', () => {
      if (this.resizeTimeout) {
        clearTimeout(this.resizeTimeout);
      }
      this._maskRect = null; // invalidate on resize
      this.resizeTimeout = setTimeout(() => {
        if (this.negativeImage) {
          this.setupMaskCanvas();
        }
      }, 200);
    });

    // ADD: one delegated listener for all grade menus
    document.addEventListener('click', (e) => {
      // toggle open on grade-display
      const display = e.target.closest('.grade-display');
      if (display) {
        const item = display.closest('.exposure-item');
        item?.querySelector('.grade-options')?.classList.toggle('show');
        return;
      }

      // choose an option
      const option = e.target.closest('.grade-option');
      if (option) {
        const item = option.closest('.exposure-item');
        const exposureId = item?.dataset.exposureId;
        if (!exposureId) return;

        const gradeValue = option.getAttribute('data-value');
        const exposure = this.exposures.find(exp => exp.id === exposureId);
        if (!exposure) return;

        // Save state before changing grade
        this.saveState();

        exposure.grade = parseInt(gradeValue, 10);

        const gradeSelect = item.querySelector('.exposure-grade');
        const gradeDisplay = item.querySelector('.grade-display');
        if (gradeSelect) gradeSelect.value = gradeValue;
        if (gradeDisplay) {
          gradeDisplay.className = `grade-display grade-${gradeValue}`;
          gradeDisplay.textContent = option.textContent;
        }
        item.querySelector('.grade-options')?.classList.remove('show');

        this.markDirty();               // ADD
        this.requestProcess();
        return;
      }

      // clicking outside closes any open menus
      document.querySelectorAll('.grade-options.show')
        .forEach(el => el.classList.remove('show'));
    });

    // One listener on the list container handles selection for all items
    const exposuresListEl = document.getElementById('exposures-list');
    if (exposuresListEl) {
      exposuresListEl.addEventListener('click', (e) => {
        // Ignore clicks on controls
        if (e.target.closest('button, select, .grade-options')) return;

        const item = e.target.closest('.exposure-item');
        if (!item) return;

        const id = item.getAttribute('data-exposure-id');
        if (id) this.selectExposure(id);
      });
    }
  },

  // Check URL parameters for image file handle
  checkUrlParameters: async function() {
    const urlParams = new URLSearchParams(window.location.search);
    const fileHandleId = urlParams.get('fileHandleId');

    if (fileHandleId) {
      try {
        // Get the file handle from IndexedDB
        const fileHandle = await idbGet(fileHandleId);

        // Also get the directory handle from IndexedDB
        try {
          directoryHandle = await idbGet('darkroomDirectoryHandle');
        } catch (dirError) {
          console.warn('Could not retrieve directory handle from IndexedDB:', dirError);
        }

        if (fileHandle) {
          currentFileHandle = fileHandle;
          this.loadingProjectData = true;
          await this.loadImageFromFileHandle(fileHandle);
          // Note: loadingProjectData is set to false in loadImageFromFileHandle
        }
      } catch (error) {
        console.error('Error loading image from URL parameter:', error);
      }
    }
  },

  // Load image from file handle
  loadImageFromFileHandle: async function(fileHandle) {
    try {
      // Get the file from the file handle
      const file = await fileHandle.getFile();

      // Create a URL for the file
      const imageUrl = URL.createObjectURL(file);

      // Load the image
      await this.loadImage(imageUrl);

      // Store the current file handle
      currentFileHandle = fileHandle;

      // Try to load associated project data
      try {
        this.loadingProjectData = true;
        await this.loadProjectData();
      } catch (projectError) {
        // Log but don't alert - not critical for functionality
        console.warn('Error loading project data:', projectError);
      } finally {
        this.loadingProjectData = false;
      }
    } catch (error) {
      console.error('Error loading image from file handle:', error);
      // Only show alert for errors that would prevent the image from loading
      if (error.message !== 'directoryHandle is not defined') {
        alert('Error loading image: ' + error.message);
      }
    }
  },

  // Load project data for the current image
  loadProjectData: async function() {
    if (!currentFileHandle) {
      console.warn('Cannot load project data: No file handle available');
      return;
    }

    if (!directoryHandle) {
      console.warn('Cannot load project data: No directory handle available');
      // We don't show an alert here as it's not critical for functionality
      return;
    }

    try {
      // First try to load the binary format (.ddr)
      const binaryFileName = currentFileHandle.name.substring(0, currentFileHandle.name.lastIndexOf('.')) + '.ddr';

      try {
        const binaryFileHandle = await directoryHandle.getFileHandle(binaryFileName);
        const file = await binaryFileHandle.getFile();
        const buffer = await file.arrayBuffer();

        // Parse the binary data
        const projectData = this.parseBinaryProjectData(buffer);

        if (projectData) {
          // Apply the project data
          this.applyProjectData(projectData);
          return; // Successfully loaded binary data, no need to try JSON
        }
      } catch (binaryError) {
        console.log('No binary project data found, trying JSON format...');
      }

      // Fall back to JSON format if binary format fails or doesn't exist
      const jsonFileName = currentFileHandle.name.substring(0, currentFileHandle.name.lastIndexOf('.')) + '.json';

      try {
        const jsonFileHandle = await directoryHandle.getFileHandle(jsonFileName);
        const file = await jsonFileHandle.getFile();
        const text = await file.text();
        const projectData = JSON.parse(text);

        // Apply the project data
        this.applyProjectData(projectData);

        // If we successfully loaded from JSON, save in binary format for next time
        console.log('Project data loaded from JSON. Converting to binary format for future use.');
        this.saveProjectData();
      } catch (jsonError) {
        // Neither binary nor JSON file exists or can be read, which is fine for new images
        console.log('No project data found for this image');
      }
    } catch (error) {
      console.error('Error loading project data:', error);
    }
  },

  // Parse binary project data
  parseBinaryProjectData: function(buffer) {
    try {
      const view = new DataView(buffer);
      let offset = 0;

      // Check magic number "DDRM"
      if (view.getUint8(offset++) !== 68 || // 'D'
          view.getUint8(offset++) !== 68 || // 'D'
          view.getUint8(offset++) !== 82 || // 'R'
          view.getUint8(offset++) !== 77) { // 'M'
        console.error('Invalid binary project data format (wrong magic number)');
        return null;
      }

      // Check version
      const version = view.getUint32(offset, true);
      offset += 4;

      if (version !== 1) {
        console.error(`Unsupported binary project data version: ${version}`);
        return null;
      }

      // Read paper type
      const paperTypeLength = view.getUint32(offset, true);
      offset += 4;

      const paperTypeBytes = new Uint8Array(buffer, offset, paperTypeLength);
      offset += paperTypeLength;

      const paperType = new TextDecoder().decode(paperTypeBytes);

      // Read number of exposures
      const exposureCount = view.getUint32(offset, true);
      offset += 4;

      // Read exposures
      const exposures = [];

      for (let i = 0; i < exposureCount; i++) {
        // Read id
        const idLength = view.getUint32(offset, true);
        offset += 4;

        const idBytes = new Uint8Array(buffer, offset, idLength);
        offset += idLength;

        const id = new TextDecoder().decode(idBytes);

        // Read time
        const time = view.getFloat64(offset, true);
        offset += 8;

        // Read grade
        const grade = view.getInt32(offset, true);
        offset += 4;

        // Read has mask flag
        const hasMask = view.getUint8(offset++) === 1;

        let maskData = null;

        // If has mask, read mask data
        if (hasMask) {
          // Read width and height
          const width = view.getUint32(offset, true);
          offset += 4;

          const height = view.getUint32(offset, true);
          offset += 4;

          // Create ImageData for the mask
          const maskDataArray = new Uint8ClampedArray(buffer, offset, width * height * 4);
          offset += width * height * 4;

          maskData = {
            width: width,
            height: height,
            data: maskDataArray
          };
        }

        exposures.push({
          id: id,
          time: time,
          grade: grade,
          maskData: maskData
        });
      }

      return {
        paperType: paperType,
        exposures: exposures
      };
    } catch (error) {
      console.error('Error parsing binary project data:', error);
      return null;
    }
  },

  // Apply loaded project data
  applyProjectData: function(projectData) {
    if (!projectData) return;

    // Set paper type
    if (projectData.paperType) {
      this.paperType = projectData.paperType;
      document.getElementById('paper-type').value = this.paperType;
    }

    // Set exposures
    if (projectData.exposures && projectData.exposures.length > 0) {
      // Clear existing exposures
      this.exposures = [];
      const exposuresList = document.getElementById('exposures-list');
      exposuresList.innerHTML = '';

      // Add each exposure from the project data
      projectData.exposures.forEach(exp => {
        const exposureId = this.addExposure();
        const exposureEl = document.querySelector(`[data-exposure-id="${exposureId}"]`);

        // Set exposure values
        if (exposureEl) {
          const timeSelect = exposureEl.querySelector('.exposure-time');
          const gradeSelect = exposureEl.querySelector('.exposure-grade');

          // Update the UI elements
          if (timeSelect && exp.time) timeSelect.value = exp.time;
          if (gradeSelect && exp.grade !== undefined) gradeSelect.value = exp.grade;

          // Update the grade display
          const gradeDisplay = exposureEl.querySelector('.grade-display');
          if (gradeDisplay && exp.grade !== undefined) {
            gradeDisplay.className = `grade-display grade-${exp.grade}`;
            gradeDisplay.textContent = gradeSelect.options[gradeSelect.selectedIndex].text;
          }

          // Update the exposure object in the exposures array
          const exposure = this.exposures.find(e => e.id === exposureId);
          if (exposure) {
            if (exp.time) exposure.time = parseFloat(exp.time);
            if (exp.grade !== undefined) exposure.grade = parseInt(exp.grade, 10);

            // Set the mask data if it exists
            if (exp.maskData) {
              exposure.maskData = exp.maskData;

              // Update the preview
              const previewCanvas = exposureEl.querySelector('.dodge-mask-preview');
              if (previewCanvas) {
                this.updateDodgeMaskPreview(previewCanvas, exposure.maskData);
              }
            }
          }
        }
      });

      // Process the image with the loaded settings
      this.requestProcess();
    }

    // ensure we don't auto-save a just-loaded state
    this._dirtySinceSave = false;
  },

  // Update tool buttons to show active state
  updateToolButtons: function() {
    const dodgeToolEl = document.getElementById('dodge-tool');
    const eraseToolEl = document.getElementById('erase-tool');
    const toolControlsEl = document.querySelector('.tool-controls');

    if (dodgeToolEl && eraseToolEl) {
      dodgeToolEl.classList.toggle('active', this.activeTool === 'dodge');
      eraseToolEl.classList.toggle('active', this.activeTool === 'erase');

      // Show tool controls when a tool is active
      if (toolControlsEl) {
        toolControlsEl.classList.toggle('hidden', !this.isMaskToolActive);
      }
    }
  },

  // Add a new exposure
  addExposure: function() {
    const exposureId = Date.now().toString();

    // Create empty mask data if we have a negative image
    let initialMaskData = null;
    if (this.negativeImage) {
      // Create an empty ImageData with the same dimensions as the negative image
      const canvas = document.createElement('canvas');
      canvas.width = this.negativeImage.width;
      canvas.height = this.negativeImage.height;
      const ctx = canvas.getContext('2d');
      initialMaskData = ctx.createImageData(canvas.width, canvas.height);
    }

    const exposure = {
      id: exposureId,
      time: 16, // Default 16 seconds
      grade: 5,  // Default grade 2
      maskData: initialMaskData
    };

    this.exposures.push(exposure);

    // Create exposure UI element
    const exposuresList = document.getElementById('exposures-list');
    const exposureTemplate = document.querySelector('.exposure-template').cloneNode(true);
    const exposureItem = exposureTemplate.querySelector('.exposure-item');

    exposureItem.setAttribute('data-exposure-id', exposureId);
    exposureItem.classList.remove('hidden');

    // Add event listeners to the exposure controls
    this.setupExposureControls(exposureItem, exposureId);

    // Add to the list
    exposuresList.appendChild(exposureItem);

    // Initialize the dodge mask preview
    const previewCanvas = exposureItem.querySelector('.dodge-mask-preview');
    if (previewCanvas && initialMaskData) {
      this.updateDodgeMaskPreview(previewCanvas, initialMaskData);
    }

    // Update button states for all exposures
    this.updateAllExposureButtons();

    // Select the new exposure
    this.selectExposure(exposureId);

    // Process the image with the new exposure
    if (this.negativeImage) {
      this.markDirty();               // ADD
      this.requestProcess();
    }

    return exposureId;
  },

  // Set up event listeners for exposure controls
  setupExposureControls: function(exposureItem, exposureId) {
    // Time selection
    const timeSelect = exposureItem.querySelector('.exposure-time');
    if (timeSelect) {
      timeSelect.addEventListener('change', (e) => {
        // Save state before changing time
        this.saveState();

        const exposure = this.exposures.find(exp => exp.id === exposureId);
        if (exposure) {
          exposure.time = parseFloat(e.target.value);
          this.markDirty();           // ADD
          this.requestProcess();
        }
      });
    }

    // Grade selection
    const gradeSelect = exposureItem.querySelector('.exposure-grade');
    // Note: Grade display click events are now handled by the delegated listener in setupEventListeners

    // Move up button
    const moveUpButton = exposureItem.querySelector('.move-up-button');
    if (moveUpButton) {
      moveUpButton.addEventListener('click', () => {
        this.moveExposure(exposureId, 'up');
      });
    }

    // Move down button
    const moveDownButton = exposureItem.querySelector('.move-down-button');
    if (moveDownButton) {
      moveDownButton.addEventListener('click', () => {
        this.moveExposure(exposureId, 'down');
      });
    }

    // Clone button
    const cloneButton = exposureItem.querySelector('.clone-button');
    if (cloneButton) {
      cloneButton.addEventListener('click', () => {
        this.cloneExposure(exposureId);
      });
    }

    // Invert dodge mask button
    const invertButton = exposureItem.querySelector('.invert-button');
    if (invertButton) {
      invertButton.addEventListener('click', () => {
        this.invertDodgeMask(exposureId);
      });
    }

    // Delete button
    const deleteButton = exposureItem.querySelector('.delete-button');
    if (deleteButton) {
      deleteButton.addEventListener('click', () => {
        this.deleteExposure(exposureId);
      });
    }

    // Update button states based on exposure position
    this.updateExposureButtons(exposureId);
  },

  // Update exposure button states based on position
  updateExposureButtons: function(exposureId) {
    const index = this.exposures.findIndex(exp => exp.id === exposureId);
    if (index === -1) return;

    const exposureItem = document.querySelector(`[data-exposure-id="${exposureId}"]`);
    if (!exposureItem) return;

    const moveUpButton = exposureItem.querySelector('.move-up-button');
    const moveDownButton = exposureItem.querySelector('.move-down-button');
    const deleteButton = exposureItem.querySelector('.delete-button');

    // Disable delete button when there's only one exposure
    if (deleteButton) {
      deleteButton.disabled = this.exposures.length <= 1;
    }

    // Disable move up button for the first exposure
    if (moveUpButton) {
      moveUpButton.disabled = index === 0;
    }

    // Disable move down button for the last exposure
    if (moveDownButton) {
      moveDownButton.disabled = index === this.exposures.length - 1;
    }
  },

  // Update all exposure buttons
  updateAllExposureButtons: function() {
    // Update button states for all exposures
    this.exposures.forEach(exposure => {
      this.updateExposureButtons(exposure.id);
    });
  },

  // Select an exposure
  selectExposure: function (exposureId) {
    // HARD GUARD: if it's already selected, do nothing.
    if (this.selectedExposureId === exposureId) return;

    // Deselect all exposures
    const exposureItems = document.querySelectorAll('.exposure-item');
    exposureItems.forEach(item => item.classList.remove('selected'));

    // Select the specified exposure
    const selectedItem = document.querySelector(`[data-exposure-id="${exposureId}"]`);
    if (selectedItem) {
      selectedItem.classList.add('selected');
      this.selectedExposureId = exposureId;

      if (this.negativeImage) this.setupMaskCanvas();
    }
  },

  // Move an exposure up or down in the list
  moveExposure: function(exposureId, direction) {
    // Save state before moving exposure
    this.saveState();

    const index = this.exposures.findIndex(exp => exp.id === exposureId);
    if (index === -1) return;

    if (direction === 'up' && index > 0) {
      // Swap with previous exposure
      [this.exposures[index], this.exposures[index - 1]] = [this.exposures[index - 1], this.exposures[index]];

      // Update UI
      const exposuresList = document.getElementById('exposures-list');
      const exposureItem = document.querySelector(`[data-exposure-id="${exposureId}"]`);
      const prevItem = exposureItem.previousElementSibling;

      if (prevItem) {
        exposuresList.insertBefore(exposureItem, prevItem);
      }
    } else if (direction === 'down' && index < this.exposures.length - 1) {
      // Swap with next exposure
      [this.exposures[index], this.exposures[index + 1]] = [this.exposures[index + 1], this.exposures[index]];

      // Update UI
      const exposuresList = document.getElementById('exposures-list');
      const exposureItem = document.querySelector(`[data-exposure-id="${exposureId}"]`);
      const nextItem = exposureItem.nextElementSibling;

      if (nextItem && nextItem.nextElementSibling) {
        exposuresList.insertBefore(exposureItem, nextItem.nextElementSibling);
      } else if (nextItem) {
        exposuresList.appendChild(exposureItem);
      }
    }

    // Update button states for all exposures
    this.updateAllExposureButtons();

    // Process the image with the new order
    this.markDirty();               // ADD
    this.requestProcess();
  },

  // Delete an exposure
  deleteExposure: function(exposureId) {
    // Save state before deleting exposure
    this.saveState();

    // Remove from exposures array
    const index = this.exposures.findIndex(exp => exp.id === exposureId);
    if (index === -1) return;

    this.exposures.splice(index, 1);

    // Remove from UI
    const exposureItem = document.querySelector(`[data-exposure-id="${exposureId}"]`);
    if (exposureItem) {
      exposureItem.remove();
    }

    // If we deleted the selected exposure, select another one
    if (this.selectedExposureId === exposureId) {
      if (this.exposures.length > 0) {
        this.selectExposure(this.exposures[0].id);
      } else {
        this.selectedExposureId = null;
      }
    }

    // If no exposures left, add a default one (unless we're loading project data)
    if (this.exposures.length === 0 && !this.loadingProjectData) {
      this.addExposure();
    } else {
      // Update button states for all exposures
      this.updateAllExposureButtons();

      // Process the image with the updated exposures
      this.markDirty();               // ADD
      this.requestProcess();
    }
  },

  // Clone an exposure
  cloneExposure: function(exposureId) {
    // Save state before cloning exposure
    this.saveState();

    // Find the exposure to clone
    const sourceExposure = this.exposures.find(exp => exp.id === exposureId);
    if (!sourceExposure) return;

    // Create a new exposure ID
    const newExposureId = Date.now().toString();

    // Create a deep copy of the mask data if it exists
    let clonedMaskData = null;
    if (sourceExposure.maskData) {
      const canvas = document.createElement('canvas');
      canvas.width = sourceExposure.maskData.width;
      canvas.height = sourceExposure.maskData.height;
      const ctx = canvas.getContext('2d');

      // Create a new ImageData object with the same dimensions
      clonedMaskData = ctx.createImageData(canvas.width, canvas.height);

      // Copy the pixel data from the source mask
      const sourceData = sourceExposure.maskData.data;
      const clonedData = clonedMaskData.data;
      for (let i = 0; i < sourceData.length; i++) {
        clonedData[i] = sourceData[i];
      }
    }

    // Create the cloned exposure object
    const clonedExposure = {
      id: newExposureId,
      time: sourceExposure.time,
      grade: sourceExposure.grade,
      maskData: clonedMaskData
    };

    // Add the cloned exposure to the exposures array
    this.exposures.push(clonedExposure);

    // Create exposure UI element
    const exposuresList = document.getElementById('exposures-list');
    const exposureTemplate = document.querySelector('.exposure-template').cloneNode(true);
    const exposureItem = exposureTemplate.querySelector('.exposure-item');

    exposureItem.setAttribute('data-exposure-id', newExposureId);
    exposureItem.classList.remove('hidden');

    // Set the initial values for time and grade
    const timeSelect = exposureItem.querySelector('.exposure-time');
    if (timeSelect) {
      timeSelect.value = clonedExposure.time;
    }

    const gradeSelect = exposureItem.querySelector('.exposure-grade');
    if (gradeSelect) {
      gradeSelect.value = clonedExposure.grade;
    }

    const gradeDisplay = exposureItem.querySelector('.grade-display');
    if (gradeDisplay) {
      // Remove all grade classes
      for (let i = 0; i <= 11; i++) {
        gradeDisplay.classList.remove(`grade-${i}`);
      }
      // Add the correct grade class
      gradeDisplay.classList.add(`grade-${clonedExposure.grade}`);

      // Set the text content based on the grade
      const gradeOption = document.querySelector(`.grade-option[data-value="${clonedExposure.grade}"]`);
      if (gradeOption) {
        gradeDisplay.textContent = gradeOption.textContent;
      }
    }

    // Add event listeners to the exposure controls
    this.setupExposureControls(exposureItem, newExposureId);

    // Add to the list
    exposuresList.appendChild(exposureItem);

    // Initialize the dodge mask preview
    const previewCanvas = exposureItem.querySelector('.dodge-mask-preview');
    if (previewCanvas && clonedMaskData) {
      this.updateDodgeMaskPreview(previewCanvas, clonedMaskData);
    }

    // Update button states for all exposures
    this.updateAllExposureButtons();

    // Select the new exposure
    this.selectExposure(newExposureId);

    // Process the image with the new exposure
    if (this.negativeImage) {
      this.markDirty();
      this.requestProcess();
    }
  },

  // Invert the dodge mask for an exposure
  invertDodgeMask: function(exposureId) {
    // Save state before inverting dodge mask
    this.saveState();

    // Find the exposure
    const exposure = this.exposures.find(exp => exp.id === exposureId);
    if (!exposure || !exposure.maskData) return;

    // Create a canvas to work with the mask data
    const canvas = document.createElement('canvas');
    canvas.width = exposure.maskData.width;
    canvas.height = exposure.maskData.height;
    const ctx = canvas.getContext('2d');

    // Create a new ImageData object from the exposure's mask data
    const maskImage = new ImageData(
      new Uint8ClampedArray(exposure.maskData.data),
      exposure.maskData.width,
      exposure.maskData.height
    );

    // Put the current mask data on the canvas
    ctx.putImageData(maskImage, 0, 0);

    // Get the image data to manipulate
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    // Invert the alpha channel (every 4th byte)
    for (let i = 3; i < data.length; i += 4) {
      data[i] = 255 - data[i]; // Invert alpha (255 becomes 0, 0 becomes 255)
    }

    // Update the exposure's mask data
    exposure.maskData = imageData;

    // Update the mask canvas if this is the selected exposure
    if (this.selectedExposureId === exposureId && this.maskCtx) {
      this.maskCtx.putImageData(imageData, 0, 0);
    }

    // Update the preview
    const exposureItem = document.querySelector(`[data-exposure-id="${exposureId}"]`);
    if (exposureItem) {
      const previewCanvas = exposureItem.querySelector('.dodge-mask-preview');
      if (previewCanvas) {
        this.updateDodgeMaskPreview(previewCanvas, exposure.maskData);
      }
    }

    // Process the image with the updated mask
    this.markDirty();
    this.requestProcess();
  },

  // Set up the mask canvas for the selected exposure
  setupMaskCanvas: function() {
    if (!this.negativeImage || !this.selectedExposureId) return;

    // Prevent multiple calls for the same exposure ID within a short time period
    if (this._setupMaskLastExposureId === this.selectedExposureId && this._setupMaskDebounce) {
      clearTimeout(this._setupMaskDebounce);
      // If RAF is already scheduled, let it complete
      if (this._setupMaskRAF) return;
    }

    // Store the current exposure ID
    this._setupMaskLastExposureId = this.selectedExposureId;

    // Set a debounce timeout to prevent multiple calls
    this._setupMaskDebounce = setTimeout(() => {
      this._setupMaskDebounce = null;
    }, 300); // 300ms debounce

    // Cancel any existing RAF
    if (this._setupMaskRAF) {
      cancelAnimationFrame(this._setupMaskRAF);
    }

    // Schedule the actual work in RAF
    this._setupMaskRAF = requestAnimationFrame(() => {
      this._setupMaskRAF = null;

      // Get the selected exposure
      const exposure = this.exposures.find(exp => exp.id === this.selectedExposureId);
      if (!exposure) return;

      // Set up mask canvas
      this.maskCanvas = document.getElementById('mask-canvas');
      this.maskCtx = this.maskCanvas.getContext('2d', { willReadFrequently: true });

      // Size the mask canvas to match the negative image
      const imgRect = this.negativeImageEl.getBoundingClientRect();
      this.maskCanvas.width = this.negativeImage.width;
      this.maskCanvas.height = this.negativeImage.height;

      // Clear the mask canvas
      this.maskCtx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);

      // If the exposure has mask data, draw it
      if (exposure.maskData) {
        // Create a new ImageData object from the exposure's mask data
        const maskImage = new ImageData(
          new Uint8ClampedArray(exposure.maskData.data),
          exposure.maskData.width,
          exposure.maskData.height
        );

        // Create a temporary ImageData to convert alpha to red (like in updateDodgeMaskPreview)
        const tempData = new ImageData(maskImage.width, maskImage.height);
        const src = maskImage.data;
        const dst = tempData.data;

        // Convert alpha to red (same as in updateDodgeMaskPreview)
        for (let i = 0; i < src.length; i += 4) {
          const a = src[i + 3]; // alpha
          dst[i] = a;        // red channel from alpha
          dst[i+1] = 0;      // green channel = 0
          dst[i+2] = 0;      // blue channel = 0
          dst[i+3] = a;      // use original alpha for transparency
        }

        // Draw the converted data to the mask canvas
        this.maskCtx.putImageData(tempData, 0, 0);
      }

      // Show the mask canvas
      this.maskCanvas.classList.remove('hidden');

      // Ensure preview canvas exists and is sized/positioned to match the image
      let previewCanvas = document.getElementById('preview-canvas');
      if (!previewCanvas) {
        previewCanvas = document.createElement('canvas');
        previewCanvas.id = 'preview-canvas';
        // Put it right after the mask canvas so it stacks above
        this.maskCanvas.parentNode.insertBefore(previewCanvas, this.maskCanvas.nextSibling);
      }

      // Match intrinsic pixel size to mask canvas (important for crisp circles)
      previewCanvas.width = this.maskCanvas.width;
      previewCanvas.height = this.maskCanvas.height;

      // Match on-screen size & overlay it
      Object.assign(previewCanvas.style, {
        position: 'absolute',
        left: this.negativeImageEl.offsetLeft + 'px',
        top: this.negativeImageEl.offsetTop + 'px',
        width: imgRect.width + 'px',
        height: imgRect.height + 'px',
        pointerEvents: 'none',   // don't block drawing
        zIndex: 3                // above mask canvas
      });

      // Make sure mask canvas is also absolutely positioned above the image
      Object.assign(this.maskCanvas.style, {
        position: 'absolute',
        left: this.negativeImageEl.offsetLeft + 'px',
        top: this.negativeImageEl.offsetTop + 'px',
        width: imgRect.width + 'px',
        height: imgRect.height + 'px',
        zIndex: 2
      });

      // And the image container should be relatively positioned
      const container = this.negativeImageEl.parentElement;
      if (container && getComputedStyle(container).position === 'static') {
        container.style.position = 'relative';
      }

      // Set up painting handlers if not already attached
      if (!this.paintingHandlersAttached) {
        this.setupPaintingHandlers();
        this.paintingHandlersAttached = true;
      }

      // Draw initial preview circles
      this.drawPreviewCircles(null, null);

      // ADD at end of setupMaskCanvas()
      this.makeBrushStamp();
    });
  },

  // Set up event handlers for painting on the mask canvas
  setupPaintingHandlers: function() {
    if (!this.maskCanvas) return;

    // Mouse down handler
    this.maskCanvas.addEventListener('mousedown', (e) => {
      // Save the current state before drawing
      this.saveState();

      this.isDrawing = true;
      const rect = this._maskRect || (this._maskRect = this.maskCanvas.getBoundingClientRect());
      const scaleX = this.maskCanvas.width / rect.width;
      const scaleY = this.maskCanvas.height / rect.height;

      this.lastX = (e.clientX - rect.left) * scaleX;
      this.lastY = (e.clientY - rect.top) * scaleY;

      // Draw a single point
      this.drawMaskPoint(this.lastX, this.lastY);
    });

    // Touch start handler
    this.maskCanvas.addEventListener('touchstart', (e) => {
      // Prevent default to stop scrolling
      e.preventDefault();

      // Save the current state before drawing
      this.saveState();

      this.isDrawing = true;
      const rect = this._maskRect || (this._maskRect = this.maskCanvas.getBoundingClientRect());
      const scaleX = this.maskCanvas.width / rect.width;
      const scaleY = this.maskCanvas.height / rect.height;

      const touch = e.touches[0];
      this.lastX = (touch.clientX - rect.left) * scaleX;
      this.lastY = (touch.clientY - rect.top) * scaleY;

      // Draw a single point
      this.drawMaskPoint(this.lastX, this.lastY);
    });

    // Mouse move handler
    this.maskCanvas.addEventListener('mousemove', (e) => {
      const rect = this._maskRect || (this._maskRect = this.maskCanvas.getBoundingClientRect());
      const scaleX = this.maskCanvas.width / rect.width;
      const scaleY = this.maskCanvas.height / rect.height;

      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top) * scaleY;

      // Keep a copy of the previous point BEFORE updating
      const prevX = this.lastX;
      const prevY = this.lastY;

      // Update last known position (used by preview + next segment)
      this.lastX = x;
      this.lastY = y;

      if (this.isDrawing) {
        this.drawMaskLine(prevX, prevY, x, y);  // ← use previous point
      } else {
        // Draw preview circles
        this.drawPreviewCircles(x, y, scaleX, scaleY);
      }
    });

    // Touch move handler
    this.maskCanvas.addEventListener('touchmove', (e) => {
      // Prevent default to stop scrolling
      e.preventDefault();

      const rect = this._maskRect || (this._maskRect = this.maskCanvas.getBoundingClientRect());
      const scaleX = this.maskCanvas.width / rect.width;
      const scaleY = this.maskCanvas.height / rect.height;

      const touch = e.touches[0];
      const x = (touch.clientX - rect.left) * scaleX;
      const y = (touch.clientY - rect.top) * scaleY;

      // Keep a copy of the previous point BEFORE updating
      const prevX = this.lastX;
      const prevY = this.lastY;

      // Update last known position (used by preview + next segment)
      this.lastX = x;
      this.lastY = y;

      if (this.isDrawing) {
        this.drawMaskLine(prevX, prevY, x, y);  // ← use previous point
      }
    });

    // Mouse up and mouse leave handlers
    const endDrawing = () => {
      if (this.isDrawing) {
        this.isDrawing = false;

        // Save the mask data to the current exposure
        if (this.selectedExposureId) {
          const exposure = this.exposures.find(exp => exp.id === this.selectedExposureId);
          if (exposure) {
            exposure.maskData = this.maskCtx.getImageData(0, 0, this.maskCanvas.width, this.maskCanvas.height);

            // Update the preview
            const exposureItem = document.querySelector(`[data-exposure-id="${this.selectedExposureId}"]`);
            if (exposureItem) {
              const previewCanvas = exposureItem.querySelector('.dodge-mask-preview');
              if (previewCanvas) {
                this.updateDodgeMaskPreview(previewCanvas, exposure.maskData);
              }
            }

            // Process the image with the updated mask
            this.markDirty();               // ADD
            this.requestProcess();
          }
        }
      }
    };

    this.maskCanvas.addEventListener('mouseup', endDrawing);
    this.maskCanvas.addEventListener('mouseleave', endDrawing);
    this.maskCanvas.addEventListener('touchend', (e) => {
      e.preventDefault();
      endDrawing();
    });
    this.maskCanvas.addEventListener('touchcancel', (e) => {
      e.preventDefault();
      endDrawing();
    });
  },

  // ADD: builds a brush sprite when size/feather/tool changes
  makeBrushStamp: function () {
    if (!this.maskCanvas) return;
    const size = Math.max(2, (this.maskCanvas.width * (this.brushSize / 100)));
    const r = size / 2;
    const featherPx = r * (this.brushFeather / 100);

    const c = this._brushCanvas || (this._brushCanvas = document.createElement('canvas'));
    c.width = c.height = Math.ceil(size);
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);

    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    if (this.activeTool === 'dodge') {
      const innerRadius = Math.max(0, 1 - featherPx / r);
      g.addColorStop(0, `rgba(255, 0, 0, ${this.brushFlow})`);
      g.addColorStop(innerRadius, `rgba(255, 0, 0, ${this.brushFlow})`);

      // Add multiple intermediate stops for a smoother gradient
      const steps = 50; // Increased number of steps for smoother transition
      for (let i = 1; i <= steps; i++) {
        const pos = innerRadius + (1 - innerRadius) * (i / steps);
        // Use a non-linear (quadratic) function for smoother alpha transition
        const t = i / steps;
        const alpha = this.brushFlow * (1 - t * t);
        g.addColorStop(pos, `rgba(255, 0, 0, ${alpha})`);
      }

      g.addColorStop(1, 'rgba(255, 0, 0, 0)');
    } else {
      const innerRadius = Math.max(0, 1 - featherPx / r);
      g.addColorStop(0, 'rgba(0, 0, 0, 1)');
      g.addColorStop(innerRadius, 'rgba(0, 0, 0, 1)');

      // Add multiple intermediate stops for a smoother gradient
      const steps = 50; // Increased number of steps for smoother transition
      for (let i = 1; i <= steps; i++) {
        const pos = innerRadius + (1 - innerRadius) * (i / steps);
        // Use a non-linear (quadratic) function for smoother alpha transition
        const t = i / steps;
        const alpha = 1 - t * t;
        g.addColorStop(pos, `rgba(0, 0, 0, ${alpha})`);
      }

      g.addColorStop(1, 'rgba(0, 0, 0, 0)');
    }

    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(r, r, r, 0, Math.PI * 2);
    ctx.fill();

    this._brushStamp = c;
  },

  // REPLACE drawMaskPoint
  drawMaskPoint: function(x, y) {
    if (!this.maskCtx || !this._brushStamp) return;
    this.maskCtx.globalCompositeOperation = this.activeTool === 'dodge' ? 'source-over' : 'destination-out';
    const s = this._brushStamp;
    this.maskCtx.drawImage(s, Math.round(x - s.width / 2), Math.round(y - s.height / 2));
  },

  // REPLACE drawMaskLine
  drawMaskLine: function(x1, y1, x2, y2) {
    if (!this.maskCtx) return;
    const dx = x2 - x1, dy = y2 - y1;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) { this.drawMaskPoint(x2, y2); return; }

    const brushSizePx = Math.max(2, (this.maskCanvas.width * (this.brushSize / 100)));
    const step = brushSizePx / 2; // fewer stamps than /4; smoother with feather
    const steps = Math.max(1, (dist / step) | 0);
    const ix = dx / steps, iy = dy / steps;

    let x = x1, y = y1;
    for (let i = 0; i <= steps; i++) {
      this.drawMaskPoint(x, y);
      x += ix; y += iy;
    }
  },

  // Draw preview circles to show brush size and feather
  drawPreviewCircles: function(x, y) {
    const previewCanvas = document.getElementById('preview-canvas');
    if (!previewCanvas || !this.maskCanvas) return;

    const previewCtx = previewCanvas.getContext('2d');
    previewCanvas.width = this.maskCanvas.width;
    previewCanvas.height = this.maskCanvas.height;

    // Clear the canvas regardless of tool state
    previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);

    // Only draw the preview circles if a mask tool (dodge or erase) is active
    if (!this.isMaskToolActive) return;

    // If no mouse yet, put the preview in the middle
    if (x == null || y == null) {
      x = this.maskCanvas.width / 2;
      y = this.maskCanvas.height / 2;
    }

    const brushSizePx = this.maskCanvas.width * (this.brushSize / 100);
    const featherPx = brushSizePx * (this.brushFeather / 100);

    previewCtx.strokeStyle = 'rgba(255,0,0,0.5)';
    previewCtx.lineWidth = 20;
    previewCtx.beginPath();
    previewCtx.arc(x, y, brushSizePx / 2, 0, Math.PI * 2);
    previewCtx.stroke();

    if (featherPx > 0) {
      previewCtx.strokeStyle = 'rgba(255,0,0,0.9)';
      previewCtx.beginPath();
      previewCtx.arc(x, y, (brushSizePx - featherPx) / 2, 0, Math.PI * 2);
      previewCtx.stroke();
    }
  },

  // Update the dodge mask preview for an exposure
  updateDodgeMaskPreview: function(previewCanvas, maskData) {
    if (!previewCanvas || !maskData) return;

    // Set maximum dimensions for the preview
    const maxWidth = 90, maxHeight = 90;

    // Calculate dimensions that maintain the aspect ratio
    let w, h;
    const aspectRatio = maskData.width / maskData.height;

    if (aspectRatio >= 1) {
      // Landscape orientation
      w = maxWidth;
      h = Math.round(w / aspectRatio);
    } else {
      // Portrait orientation
      h = maxHeight;
      w = Math.round(h * aspectRatio);
    }

    // Store the orientation as a data attribute for CSS to use
    const orientation = aspectRatio >= 1 ? 'landscape' : 'portrait';
    previewCanvas.setAttribute('data-orientation', orientation);

    // Also add a class to the parent container for easier CSS targeting
    const container = previewCanvas.closest('.dodge-mask-preview-container');
    if (container) {
      container.classList.remove('photo-landscape', 'photo-portrait');
      container.classList.add('photo-' + orientation);
    }

    previewCanvas.width = w;
    previewCanvas.height = h;
    const ctx = previewCanvas.getContext('2d');

    // First draw the negative image as background
    if (this.negativeImage) {
      ctx.drawImage(this.negativeImage, 0, 0, w, h);
    } else {
      // If no image, use dark background
      ctx.fillStyle = '#222';
      ctx.fillRect(0, 0, w, h);
    }

    // Make a small red image from alpha
    const src = maskData.data;
    const tmp = new ImageData(maskData.width, maskData.height);
    for (let i = 0; i < src.length; i += 4) {
      const a = src[i + 3]; // alpha
      tmp.data[i] = a;      // red channel from alpha
      tmp.data[i+1] = 0;    // green channel = 0
      tmp.data[i+2] = 0;    // blue channel = 0
      tmp.data[i + 3] = a;  // use original alpha for transparency
    }

    // Draw & scale down
    const c = document.createElement('canvas');
    c.width = maskData.width;
    c.height = maskData.height;
    c.getContext('2d').putImageData(tmp, 0, 0);

    // Draw the mask overlay on top of the image
    ctx.drawImage(c, 0, 0, w, h);
  },

  // Clear the mask for the selected exposure
  clearMask: function() {
    if (!this.maskCtx || !this.selectedExposureId) return;

    // Save the current state before clearing
    this.saveState();

    // Clear the mask canvas
    this.maskCtx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);

    // Update the exposure's mask data
    const exposure = this.exposures.find(exp => exp.id === this.selectedExposureId);
    if (exposure) {
      exposure.maskData = this.maskCtx.getImageData(0, 0, this.maskCanvas.width, this.maskCanvas.height);

      // Update the preview
      if (exposureItem) {
        const previewCanvas = exposureItem.querySelector('.dodge-mask-preview');
        if (previewCanvas) {
          const pctx = previewCanvas.getContext('2d');
          previewCanvas.width = imageData.width;
          previewCanvas.height = imageData.height;

          // 1) Draw the (alpha-only) mask first
          pctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
          pctx.putImageData(imageData, 0, 0);

          // 2) Colorize it: keep the red fill only where mask has alpha
          pctx.globalCompositeOperation = 'source-in';
          pctx.fillStyle = '#f00';
          pctx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);

          // 3) Reset comp op
          pctx.globalCompositeOperation = 'source-over';
        }
      }

      this.markDirty();               // ADD
      this.requestProcess();
    }
  },

  // Load an image from a URL
  loadImage: function(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();

      img.onload = () => {
        // Store the original image
        this.originalImage = img;

        // Create the negative image
        this.createNegativeImage(img);

        // Show the negative image
        this.negativeImageEl.src = this.negativeImage.src;
        this.negativeImageEl.classList.remove('hidden');

        // Note: We don't need to call setupMaskCanvas() or processImage() here
        // as they are called in the negativeImage.onload handler in createNegativeImage

        resolve();
      };

      img.onerror = () => {
        reject(new Error('Failed to load image'));
      };

      img.src = url;
    });
  },

  // Create a negative image from the original
  createNegativeImage: function(img) {
    // Create a canvas to process the image
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');

    // Draw the image to the canvas
    ctx.drawImage(img, 0, 0);

    // Get the image data
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    // Convert to grayscale and invert
    for (let i = 0; i < data.length; i += 4) {
      // Convert to grayscale using luminance formula
      const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

      // Invert the grayscale value
      const inverted = 255 - gray;

      // Set the RGB channels to the inverted value
      data[i] = inverted;
      data[i + 1] = inverted;
      data[i + 2] = inverted;
    }

    // Put the modified image data back to the canvas
    ctx.putImageData(imageData, 0, 0);

    // Store the dimensions from the canvas
    const canvasWidth = canvas.width;
    const canvasHeight = canvas.height;

    // Create an image from the canvas
    this.negativeImage = new Image();

    // Set up onload handler before setting src
    this.negativeImage.onload = () => {
      // Show the negative image
      this.negativeImageEl.classList.remove('hidden');

      // Set up the mask canvas
      this.setupMaskCanvas();

      // Process the image
      this.processImage();
    };

    this.negativeImage.src = canvas.toDataURL();

    // Upload transmittance and LUT to GPU
    this.gpu.uploadTransmittanceFromImageData(imageData);
    this.gpu.uploadLUT(this.sigmoidLUT);

    // Set width and height properties directly in case the image load is delayed
    this.negativeImage.width = canvasWidth;
    this.negativeImage.height = canvasHeight;
  },


  // Request image processing with debounce
  requestProcess: function () {
    if (this._processTimer) clearTimeout(this._processTimer);
    this._processTimer = setTimeout(() => {
      this._processTimer = null;
      this.processImage();
    }, 150); // tune 100–250ms
  },

  // ADD
  scheduleSave: function () {
    if (!this._dirtySinceSave) return; // nothing changed
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      if (!this._dirtySinceSave) return;
      this._dirtySinceSave = false;
      this.saveProjectData();
    }, 250);
  },

  // ADD
  markDirty: function () {
    this._dirtySinceSave = true;
  },

  // Image processing using GPU
  processImage: function () {
    if (!this.negativeImage || this.exposures.length === 0) return;

    const paper = this.papers[this.paperType];
    if (!paper) return;

    // Ensure canvas is visible & sized
    this.resultCanvasEl.classList.remove('hidden');

    // All per-frame data: exposure uniforms & mask textures
    this.gpu.render(paper, this.exposures, this.sigmoidLUT);

    // Read pixels from WebGL canvas for histogram
    try {
      // Get the WebGL context that's already being used
      const gl = this.gpu.gl;

      // Create a temporary canvas to copy the WebGL canvas content
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = this.resultCanvasEl.width;
      tempCanvas.height = this.resultCanvasEl.height;
      const tempCtx = tempCanvas.getContext('2d');

      // Draw the WebGL canvas onto the temporary canvas
      tempCtx.drawImage(this.resultCanvasEl, 0, 0);

      // Now get the image data from the temporary canvas
      const imgData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
      this._scheduleHistogram(imgData);

      // Show the histogram container immediately to confirm it's working
      const histogramContainer = document.getElementById('histogram-container');
      if (histogramContainer) {
        histogramContainer.classList.remove('hidden');
      }
    } catch (e) {
      console.error('Error getting image data for histogram:', e);
      // Some browsers disallow reading WebGL canvas without preserveDrawingBuffer.
      // It's okay to skip histogram if security blocks it.
      // If you want histograms, set the context with preserveDrawingBuffer: true in GPUEngine canvas getContext (tradeoff: perf/mem).
    }

    this.scheduleSave(); // keep your save throttle
  },


  // ADD (helper): sampled histogram builder
  _buildHistogramSampled: function(imageData) {
    const { data, width, height } = imageData;
    const hist = { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256) };

    // sample every 4px in both axes
    const stepX = 4, stepY = 4;
    for (let y = 0; y < height; y += stepY) {
      let row = (y * width * 4);
      for (let x = 0; x < width; x += stepX) {
        const o = row + (x << 2);
        hist.r[data[o    ]]++;
        hist.g[data[o + 1]]++;
        hist.b[data[o + 2]]++;
      }
    }
    return hist;
  },

  // ADD (helper): schedule histogram drawing when idle (fallback to immediate)
  _scheduleHistogram: function(imageData) {
    const run = () => {
      // reuse your canvas & drawing code, but feed sampled data
      const hist = this._buildHistogramSampled(imageData);
      // minimal changes inside updateHistogram: if it sees hist object, draw it.
      this.updateHistogram(imageData, hist);
    };
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(run, { timeout: 150 });
    } else {
      setTimeout(run, 0);
    }
  },

  // REPLACE signature + beginning of updateHistogram
  updateHistogram: function(imageData, prebuilt) {
    const histogramCanvas = document.getElementById('histogram-canvas');
    if (!histogramCanvas) return;

    const histogramCtx = histogramCanvas.getContext('2d');
    const histogramWidth = histogramCanvas.width;
    const histogramHeight = histogramCanvas.height;

    histogramCtx.clearRect(0, 0, histogramWidth, histogramHeight);

    const histogramData = prebuilt || (function computeFull() {
      const h = { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256) };
      const d = imageData.data;
      for (let i = 0; i < d.length; i += 4) {
        h.r[d[i]]++; h.g[d[i+1]]++; h.b[d[i+2]]++;
      }
      return h;
    }());

    // Find the maximum value for scaling
    let maxValue = 0;
    for (let i = 0; i < 256; i++) {
      maxValue = Math.max(maxValue, histogramData.r[i], histogramData.g[i], histogramData.b[i]);
    }

    // Draw background
    histogramCtx.fillStyle = '#2a0000'; // Dark red background
    histogramCtx.fillRect(0, 0, histogramWidth, histogramHeight);

    // Draw each channel
    const drawChannel = (data, color, alpha) => {
      histogramCtx.beginPath();
      histogramCtx.moveTo(0, histogramHeight);

      for (let i = 0; i < 256; i++) {
        const x = (i / 255) * histogramWidth;
        const y = histogramHeight - (data[i] / maxValue) * histogramHeight;
        histogramCtx.lineTo(x, y);
      }

      histogramCtx.lineTo(histogramWidth, histogramHeight);
      histogramCtx.closePath();

      histogramCtx.globalAlpha = alpha;
      histogramCtx.fillStyle = color;
      histogramCtx.fill();
      histogramCtx.globalAlpha = 1.0;
    };

    // Draw channels from back to front
    drawChannel(histogramData.b, 'blue', 0.5);
    drawChannel(histogramData.g, 'green', 0.5);
    drawChannel(histogramData.r, 'red', 0.5);

    // Draw border
    histogramCtx.strokeStyle = '#5a0000'; // Red border
    histogramCtx.lineWidth = 1;
    histogramCtx.strokeRect(0, 0, histogramWidth, histogramHeight);

    // Show the histogram container
    const histogramContainer = document.getElementById('histogram-container');
    if (histogramContainer) {
      histogramContainer.classList.remove('hidden');
    }

    // Store the histogram data
    this.histogramData = histogramData;
  },

  // Save the project data in binary format
  saveProjectData: async function() {
    if (!currentFileHandle) {
      console.warn('Cannot save project: No file handle available');
      return;
    }

    if (!directoryHandle) {
      console.warn('Cannot save project: No directory handle available');
      // Show a warning to the user only once per session
      if (!this.saveWarningShown) {
        alert('Warning: Your edits cannot be saved because the directory handle is not available. Please return to the contact sheet and select the image again.');
        this.saveWarningShown = true;
      }
      return;
    }

    try {
      // Create a binary file with the same name as the image but with .ddr extension
      // (Digital Darkroom Raw format)
      const binaryFileName = currentFileHandle.name.substring(0, currentFileHandle.name.lastIndexOf('.')) + '.ddr';

      // Get or create the binary file handle
      const binaryFileHandle = await directoryHandle.getFileHandle(binaryFileName, { create: true });

      // Calculate the total size needed for the binary data
      let totalSize = 0;

      // Magic number (4 bytes) + version (4 bytes)
      totalSize += 8;

      // Paper type (string length + string data)
      const paperTypeEncoder = new TextEncoder();
      const paperTypeBytes = paperTypeEncoder.encode(this.paperType);
      totalSize += 4 + paperTypeBytes.length;

      // Number of exposures (4 bytes)
      totalSize += 4;

      // For each exposure: id length + id + time (8 bytes) + grade (4 bytes) + has mask flag (1 byte)
      // If has mask: width (4 bytes) + height (4 bytes) + mask data
      for (const exp of this.exposures) {
        const idEncoder = new TextEncoder();
        const idBytes = idEncoder.encode(exp.id);
        totalSize += 4 + idBytes.length + 8 + 4 + 1;

        if (exp.maskData) {
          totalSize += 4 + 4 + exp.maskData.data.length;
        }
      }

      // Create an ArrayBuffer with the calculated size
      const buffer = new ArrayBuffer(totalSize);
      const view = new DataView(buffer);
      let offset = 0;

      // Write magic number "DDRM" (Digital Darkroom Raw Mask)
      view.setUint8(offset++, 68); // 'D'
      view.setUint8(offset++, 68); // 'D'
      view.setUint8(offset++, 82); // 'R'
      view.setUint8(offset++, 77); // 'M'

      // Write version (1)
      view.setUint32(offset, 1, true);
      offset += 4;

      // Write paper type
      view.setUint32(offset, paperTypeBytes.length, true);
      offset += 4;
      for (let i = 0; i < paperTypeBytes.length; i++) {
        view.setUint8(offset++, paperTypeBytes[i]);
      }

      // Write number of exposures
      view.setUint32(offset, this.exposures.length, true);
      offset += 4;

      // Write each exposure
      for (const exp of this.exposures) {
        // Write id
        const idBytes = new TextEncoder().encode(exp.id);
        view.setUint32(offset, idBytes.length, true);
        offset += 4;
        for (let i = 0; i < idBytes.length; i++) {
          view.setUint8(offset++, idBytes[i]);
        }

        // Write time (as float64)
        view.setFloat64(offset, parseFloat(exp.time), true);
        offset += 8;

        // Write grade (as int32)
        view.setInt32(offset, parseInt(exp.grade, 10), true);
        offset += 4;

        // Write has mask flag
        view.setUint8(offset++, exp.maskData ? 1 : 0);

        // If has mask, write mask data
        if (exp.maskData) {
          // Write width and height
          view.setUint32(offset, exp.maskData.width, true);
          offset += 4;
          view.setUint32(offset, exp.maskData.height, true);
          offset += 4;

          // Write mask data directly
          const maskData = new Uint8Array(buffer, offset, exp.maskData.data.length);
          maskData.set(new Uint8Array(exp.maskData.data));
          offset += exp.maskData.data.length;
        }
      }

      // Write the binary data to the file
      const writable = await binaryFileHandle.createWritable();
      await writable.write(buffer);
      await writable.close();

      console.log('Project data saved in binary format');
    } catch (error) {
      console.error('Error saving project data:', error);
      // Show error to user only once per session
      if (!this.saveErrorShown) {
        alert('Error saving your edits: ' + error.message);
        this.saveErrorShown = true;
      }
    }
  }
};

// Initialize the darkroom simulator when the page loads
document.addEventListener('DOMContentLoaded', function() {
  // Check if we're in the darkroom view
  if (document.getElementById('darkroom-view').classList.contains('active')) {
    DarkroomSimulator.init();
  }
});
