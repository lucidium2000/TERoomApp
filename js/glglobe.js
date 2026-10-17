/* WebGL globe renderer.
 *
 * Canvas 2D re-projects every coastline and border on the CPU each frame, and
 * on a RoomOS Desk Pro it rasterises on the CPU too (~7 fps). Here the GPU
 * does it all:
 *
 *  The camera is a real off-axis perspective ("looking through a window"): the
 *  screen is the glass at z = 0, the viewer's eye is in front of it at z = -D
 *  (moved by head tracking), and the globe is a sphere sitting behind the
 *  glass. Each pixel casts a ray from the eye through itself - so moving your
 *  head genuinely shows you around the side of the Earth.
 *
 *  1. One full-screen fragment pass: starfield, atmosphere halo, shaded ocean,
 *     graticule, land fill (from a mipmapped equirectangular coverage texture),
 *     a smooth day/night terminator and the limb.
 *  2. Coastlines and borders as true vector lines (50m Natural Earth data,
 *     ~80k segments in one static buffer), projected in the vertex shader -
 *     so they stay crisp at every zoom, unlike lines baked into a texture.
 *
 * Markers, arcs and labels stay on the 2D overlay canvas.
 *
 * createGlobeGL(canvas) -> null if WebGL is unavailable, else
 *   { setWorld({ land, coast, borders, texWidth }), setStars(canvas), render(p), resize(w, h), info }
 */
(function () {
  'use strict';

  const QUAD_VS = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

  // GLSL ES 1.0 so it runs on WebGL1 as well as WebGL2.
  const QUAD_FS = `
#ifdef GL_OES_standard_derivatives
#extension GL_OES_standard_derivatives : enable
#endif
#ifdef GL_EXT_shader_texture_lod
#extension GL_EXT_shader_texture_lod : enable
#endif
precision highp float;
uniform vec2 uRes;        // drawing-buffer size, px
uniform vec3 uEye;        // eye position, px (screen plane z = 0, +z into the screen, y down)
uniform vec3 uCtr;        // sphere centre, px
uniform float uRw;        // sphere radius, px (scene units)
uniform float uR;         // apparent radius on screen, px (for line widths)
uniform mat3 uRot;        // view (x right, y up, z toward viewer) -> world
uniform vec3 uSun;        // world unit vector toward the sun
uniform vec2 uStarOff;    // starfield pan, px
uniform float uPx;        // device px per CSS px (line widths)
uniform sampler2D uLand;  // land coverage (luminance)
uniform sampler2D uStars;
uniform sampler2D uRadar; // weather radar (RGBA, equirectangular; js/radar.js)
uniform sampler2D uRadarB;// the next radar frame, while animating
uniform float uRadarMix;  // crossfade toward uRadarB (0..1)
uniform float uRadarA;    // radar opacity (0 = off)

const float PI = 3.14159265;

float gridLine(float deg, float step, float pxPerDeg) {
  float d = abs(mod(deg + step * 0.5, step) - step * 0.5) * pxPerDeg;  // distance in px
  return 1.0 - smoothstep(0.35 * uPx, 1.1 * uPx, d);
}

float landAt(vec2 uv) {
#if defined(GL_EXT_shader_texture_lod) && defined(GL_OES_standard_derivatives)
  // atan() wraps at the antimeridian, which makes the screen-space derivative
  // of u spike there and would pick the blurriest mip along a 1px seam. Take
  // the gradient from whichever of two u's (seam at 180 or at 0) is continuous.
  float u2 = fract(uv.x + 0.5);
  vec2 dx = vec2(dFdx(uv.x), dFdx(uv.y)), dy = vec2(dFdy(uv.x), dFdy(uv.y));
  float dx2 = dFdx(u2), dy2 = dFdy(u2);
  if (abs(dx2) < abs(dx.x)) dx.x = dx2;
  if (abs(dy2) < abs(dy.x)) dy.x = dy2;
  return texture2DGradEXT(uLand, uv, dx * 0.8, dy * 0.8).r;   // slight sharpening bias
#else
  return texture2D(uLand, uv).r;
#endif
}

void main() {
  vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  // Ray from the eye through this pixel on the glass.
  vec3 dir = normalize(vec3(frag, 0.0) - uEye);
  vec3 oc = uCtr - uEye;
  float b = dot(oc, dir);
  float c2 = max(dot(oc, oc) - b * b, 0.0);   // squared miss distance from the centre
  float r = sqrt(c2) / uRw;                    // 1.0 exactly at the silhouette

  // Stars (texture holds one screen; wrap by hand - NPOT textures can't REPEAT in WebGL1).
  vec3 col = texture2D(uStars, fract((frag + uStarOff) / uRes)).rgb;

  // Atmosphere halo: 0.28 at the limb, 0.08 a third of the way out, 0 at 1.22R.
  if (r > 0.96 && r < 1.22) {
    float t = (r - 0.96) / 0.26;
    float a = t < 0.35 ? mix(0.28, 0.08, t / 0.35) : mix(0.08, 0.0, (t - 0.35) / 0.65);
    col = mix(col, vec3(0.2196, 0.7412, 0.9725), a);
  }

  if (r < 1.0) {
    vec3 hit = uEye + dir * (b - sqrt(max(uRw * uRw - c2, 0.0)));
    vec3 n = (hit - uCtr) / uRw;                 // surface normal, scene axes
    vec3 pv = vec3(n.x, -n.y, -n.z);             // -> view axes (x right, y up, z toward viewer)
    vec2 d = n.xy;                               // for the ocean shading, as before
    vec3 w = uRot * pv;
    float lat = asin(clamp(w.z, -1.0, 1.0));
    float lon = atan(w.y, w.x);
    vec2 uv = vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);

    // Ocean: offset radial shading so it reads as a sphere, not a disc.
    float ot = clamp((length(d - vec2(-0.32, -0.44)) - 0.05) / 1.38, 0.0, 1.0);
    vec3 g = ot < 0.62 ? mix(vec3(0.106, 0.161, 0.259), vec3(0.059, 0.090, 0.165), ot / 0.62)
                       : mix(vec3(0.059, 0.090, 0.165), vec3(0.031, 0.051, 0.094), (ot - 0.62) / 0.38);

    // Graticule every 15 degrees. Pixel scale from derivatives when available.
    float latDeg = lat * 180.0 / PI, lonDeg = lon * 180.0 / PI;
    float pxLat, pxLon;
#ifdef GL_OES_standard_derivatives
    pxLat = 1.0 / max(1e-4, length(vec2(dFdx(latDeg), dFdy(latDeg))));
    pxLon = 1.0 / max(1e-4, length(vec2(dFdx(lonDeg), dFdy(lonDeg))));
    if (abs(lonDeg) > 170.0) pxLon = uR * PI / 180.0 * cos(lat);   // atan seam
#else
    pxLat = uR * PI / 180.0 * pv.z;
    pxLon = uR * PI / 180.0 * cos(lat);
#endif
    float grat = max(gridLine(latDeg, 15.0, pxLat) * step(abs(latDeg), 76.0), gridLine(lonDeg, 15.0, pxLon) * step(abs(latDeg), 80.0));
    g = mix(g, vec3(0.580, 0.639, 0.722), grat * 0.16);

    g = mix(g, vec3(0.141, 0.204, 0.294), landAt(uv));          // land #24344b

    // Night: a smooth terminator, darkest about 18 degrees past it.
    g *= 1.0 - 0.5 * smoothstep(0.09, -0.3, dot(w, uSun));

    // Weather radar, over day and night alike (storms matter at night too).
    if (uRadarA > 0.0) {
      vec4 rd = texture2D(uRadar, uv);
      if (uRadarMix > 0.0) rd = mix(rd, texture2D(uRadarB, uv), uRadarMix);
      g = mix(g, rd.rgb, rd.a * uRadarA);
    }

    // Limb line, antialiased, 1.2 css px.
    float limb = 1.0 - smoothstep(0.0, 1.2 * uPx, (1.0 - r) * uR);
    g = mix(g, vec3(0.2196, 0.7412, 0.9725), limb * 0.45);

    // Antialias the disc edge against the halo.
    col = mix(col, g, clamp((1.0 - r) * uR + 0.5, 0.0, 1.0));
  }
  gl_FragColor = vec4(col, 1.0);
}`;

  // Vector lines on the sphere: unit vectors in, orthographic out.
  const LINE_VS = `
attribute vec3 aP;
uniform mat3 uRot;
uniform vec2 uRes;
uniform vec3 uEye, uCtr;
uniform float uRw;
varying float vZ;
varying vec3 vW;
void main() {
  vec3 v = aP * uRot;                 // row-vector multiply = transpose(uRot) * aP: world -> view
  vec3 n = vec3(v.x, -v.y, -v.z);     // -> scene axes
  vec3 h = uCtr + uRw * n;            // point on the sphere
  float s = -uEye.z / (h.z - uEye.z); // where the eye->point line crosses the glass (z = 0)
  vec2 p = uEye.xy + (h.xy - uEye.xy) * s;
  gl_Position = vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0);
  vZ = dot(n, normalize(uEye - h));   // > 0: facing the eye
  vW = aP;
}`;

  const LINE_FS = `
precision mediump float;
uniform vec4 uColor;
uniform vec3 uSun;
varying float vZ;
varying vec3 vW;
void main() {
  if (vZ < 0.0) discard;                                   // far side
  float night = 1.0 - 0.5 * smoothstep(0.09, -0.3, dot(normalize(vW), uSun));
  float fade = smoothstep(0.0, 0.04, vZ);                  // soften into the limb
  gl_FragColor = vec4(uColor.rgb * night, uColor.a * fade);
}`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader compile failed');
    return s;
  }
  function program(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link failed');
    return p;
  }

  window.createGlobeGL = function (canvas) {
    let gl = null;
    // antialias: MSAA keeps the 1px vector coastlines smooth.
    const opts = { alpha: false, antialias: true, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'high-performance' };
    try { gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts); } catch (_) { gl = null; }
    if (!gl) return null;

    const ext = {
      deriv: !!gl.getExtension('OES_standard_derivatives'),
      lod: !!gl.getExtension('EXT_shader_texture_lod'),
      aniso: gl.getExtension('EXT_texture_filter_anisotropic') || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic'),
    };
    let quadProg, lineProg;
    try {
      quadProg = program(gl, QUAD_VS, QUAD_FS);
      lineProg = program(gl, LINE_VS, LINE_FS);
    } catch (e) {
      console.warn('[globe] WebGL shader failed, using 2D', e);
      return null;
    }

    const quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const Q = { aPos: gl.getAttribLocation(quadProg, 'aPos') };
    for (const n of ['uRes', 'uEye', 'uCtr', 'uRw', 'uR', 'uRot', 'uSun', 'uStarOff', 'uPx', 'uLand', 'uStars', 'uRadar', 'uRadarB', 'uRadarMix', 'uRadarA']) Q[n] = gl.getUniformLocation(quadProg, n);
    const Lu = { aP: gl.getAttribLocation(lineProg, 'aP') };
    for (const n of ['uRot', 'uRes', 'uEye', 'uCtr', 'uRw', 'uColor', 'uSun']) Lu[n] = gl.getUniformLocation(lineProg, n);
    gl.useProgram(quadProg);
    gl.uniform1i(Q.uLand, 0);
    gl.uniform1i(Q.uStars, 1);
    gl.uniform1i(Q.uRadar, 2);
    gl.uniform1i(Q.uRadarB, 3);

    function makeTex(unit) {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      return t;
    }
    const landTex = makeTex(0), starTex = makeTex(1);
    // Radar frames: one texture per image, kept while that image is shown, so
    // a loop that grows a frame at a time uploads each frame only once.
    const blankTex = makeTex(2);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    let radarTexs = [blankTex], radarByImg = new Map();
    let radarA = 0, radarCur = 0, radarNext = 0, radarMix = 0;

    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    let renderer = '';
    try {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    } catch (_) { /* */ }

    let lineBuf = null, coastCount = 0, borderCount = 0, texW = 0;
    let stateBuf = null, stateCount = 0;   // state/province lines, shown with the radar

    /** Land coverage -> mipmapped luminance texture (one byte per texel, so
     *  8192x4096 is ~32 MB). Falls back to a smaller size if the device can't. */
    function buildLandTexture(land, want) {
      for (let W = Math.min(want, maxTex); W >= 2048; W /= 2) {
        let c = null;
        try {
          const H = W / 2;
          c = document.createElement('canvas'); c.width = W; c.height = H;
          const g = c.getContext('2d');
          g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
          const proj = d3.geoEquirectangular().scale(W / (2 * Math.PI)).translate([W / 2, H / 2]).precision(0.1);
          g.fillStyle = '#fff'; g.beginPath(); d3.geoPath(proj, g)(land); g.fill();
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, landTex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, gl.LUMINANCE, gl.UNSIGNED_BYTE, c);
          gl.generateMipmap(gl.TEXTURE_2D);   // power-of-two sizes, so WebGL1 allows it
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
          if (ext.aniso) {
            const max = gl.getParameter(ext.aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
            gl.texParameterf(gl.TEXTURE_2D, ext.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max));
          }
          if (gl.getError() !== gl.NO_ERROR) throw new Error('texture upload failed at ' + W);
          return W;
        } catch (e) {
          console.warn('[globe] land texture ' + W + ' failed, trying smaller', e);
        } finally {
          if (c) { c.width = 0; c.height = 0; }   // release the big canvas now
        }
      }
      throw new Error('could not build land texture');
    }

    /** MultiLineStrings -> one GL_LINES buffer of unit vectors. */
    function buildLines(coast, borders) {
      const toPairs = (geom, out) => {
        const RAD = Math.PI / 180;
        let n = 0;
        for (const line of geom.coordinates) {
          for (let i = 0; i + 1 < line.length; i++) {
            for (const [lo, la] of [line[i], line[i + 1]]) {
              const l = lo * RAD, p = la * RAD, c = Math.cos(p);
              out.push(c * Math.cos(l), c * Math.sin(l), Math.sin(p));
            }
            n += 2;
          }
        }
        return n;
      };
      const arr = [];
      coastCount = toPairs(coast, arr);
      borderCount = toPairs(borders, arr);
      lineBuf = lineBuf || gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.STATIC_DRAW);
    }

    /** State and province lines ([[lon, lat, lon, lat, ...], ...]), drawn
     *  only while the radar is on, so storms can be placed at a glance. */
    function setStates(lines) {
      const RAD = Math.PI / 180, arr = [];
      const v = (lo, la) => { const l = lo * RAD, p = la * RAD, c = Math.cos(p); arr.push(c * Math.cos(l), c * Math.sin(l), Math.sin(p)); };
      for (const ln of lines) for (let i = 0; i + 3 < ln.length; i += 2) { v(ln[i], ln[i + 1]); v(ln[i + 2], ln[i + 3]); }
      stateCount = arr.length / 3;
      stateBuf = stateBuf || gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, stateBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.STATIC_DRAW);
    }

    function setWorld(w) {
      texW = buildLandTexture(w.land, w.texWidth || 8192);
      buildLines(w.coast, w.borders);
      return { texW, segments: (coastCount + borderCount) / 2 };
    }

    function setStars(starCanvas) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, starTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, starCanvas);
    }

    /** Weather radar: an equirectangular canvas (or null to clear) and its opacity. */
    function setRadar(img, alpha) { setRadarFrames(img ? [img] : null, alpha); }
    /** Several radar frames (oldest first) for animation; null clears. */
    function setRadarFrames(imgs, alpha) {
      const next = new Map();
      for (const img of imgs || []) {
        if (!img || next.has(img)) continue;
        let t = radarByImg.get(img);
        if (!t) {
          t = makeTex(2);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        }
        next.set(img, t);
      }
      for (const [img, t] of radarByImg) if (!next.has(img)) gl.deleteTexture(t);
      radarByImg = next;
      radarTexs = (imgs || []).map((img) => next.get(img) || blankTex);
      if (!radarTexs.length) radarTexs = [blankTex];
      radarCur = radarNext = radarTexs.length - 1; radarMix = 0;
      radarA = imgs === null ? 0 : alpha != null ? alpha : radarA;
    }
    /** Show frame a, crossfading toward frame b by t (0..1). */
    function setRadarPos(a, b, t) { radarCur = a; radarNext = b; radarMix = t; }

    function resize(w, h) {
      canvas.width = w; canvas.height = h;
      gl.viewport(0, 0, w, h);
    }

    /** p: { eye:[x,y,z], ctr:[x,y,z], Rw, R, lon, lat, sun:[x,y,z], starX, starY, px }, all in drawing-buffer px. */
    function render(p) {
      const l = p.lon * Math.PI / 180, f = p.lat * Math.PI / 180;
      const sl = Math.sin(l), cl = Math.cos(l), sf = Math.sin(f), cf = Math.cos(f);
      // Columns: east, north, centre (view x, y, z in world coordinates).
      const rot = new Float32Array([-sl, cl, 0, -sf * cl, -sf * sl, cf, cf * cl, cf * sl, sf]);

      // 1. Everything but the lines, in one full-screen pass.
      gl.disable(gl.BLEND);
      gl.useProgram(quadProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      gl.enableVertexAttribArray(Q.aPos);
      gl.vertexAttribPointer(Q.aPos, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(Q.uRes, canvas.width, canvas.height);
      gl.uniform1f(Q.uRadarA, radarA);
      gl.uniform1f(Q.uRadarMix, radarMix);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, radarTexs[radarCur] || radarTexs[0]);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, radarTexs[radarNext] || radarTexs[0]);
      gl.uniform3f(Q.uEye, p.eye[0], p.eye[1], p.eye[2]);
      gl.uniform3f(Q.uCtr, p.ctr[0], p.ctr[1], p.ctr[2]);
      gl.uniform1f(Q.uRw, p.Rw);
      gl.uniform1f(Q.uR, p.R);
      gl.uniformMatrix3fv(Q.uRot, false, rot);
      gl.uniform3f(Q.uSun, p.sun[0], p.sun[1], p.sun[2]);
      gl.uniform2f(Q.uStarOff, p.starX, p.starY);
      gl.uniform1f(Q.uPx, p.px);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // 2. Coastlines, then borders, as vector lines.
      if (!lineBuf) return;
      gl.useProgram(lineProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
      gl.enableVertexAttribArray(Lu.aP);
      gl.vertexAttribPointer(Lu.aP, 3, gl.FLOAT, false, 0, 0);
      gl.uniformMatrix3fv(Lu.uRot, false, rot);
      gl.uniform2f(Lu.uRes, canvas.width, canvas.height);
      gl.uniform3f(Lu.uEye, p.eye[0], p.eye[1], p.eye[2]);
      gl.uniform3f(Lu.uCtr, p.ctr[0], p.ctr[1], p.ctr[2]);
      gl.uniform1f(Lu.uRw, p.Rw);
      gl.uniform3f(Lu.uSun, p.sun[0], p.sun[1], p.sun[2]);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform4f(Lu.uColor, 0.431, 0.549, 0.725, 0.6);    // coastline
      gl.drawArrays(gl.LINES, 0, coastCount);
      // With the radar on, borders brighten and states/provinces appear, so
      // the weather has something to be read against.
      const wx = radarA > 0;
      if (wx) gl.uniform4f(Lu.uColor, 0.62, 0.71, 0.84, 0.9);
      else gl.uniform4f(Lu.uColor, 0.282, 0.376, 0.518, 0.85);   // borders #486084
      gl.drawArrays(gl.LINES, coastCount, borderCount);
      if (wx && stateBuf && stateCount) {
        gl.bindBuffer(gl.ARRAY_BUFFER, stateBuf);
        gl.vertexAttribPointer(Lu.aP, 3, gl.FLOAT, false, 0, 0);
        gl.uniform4f(Lu.uColor, 0.58, 0.67, 0.8, 0.65);
        gl.drawArrays(gl.LINES, 0, stateCount);
      }
      gl.disable(gl.BLEND);
    }

    return { setWorld, setStates, setStars, setRadar, setRadarFrames, setRadarPos, render, resize, info: { renderer, maxTex, deriv: ext.deriv, lod: ext.lod, aniso: !!ext.aniso } };
  };
})();
