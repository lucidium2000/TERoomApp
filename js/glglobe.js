/* WebGL globe renderer.
 *
 * Canvas 2D re-projects every coastline and border on the CPU each frame, and
 * on a RoomOS device the rasterising is CPU-bound too. Here the land is drawn
 * ONCE into an equirectangular texture, and a single full-screen fragment
 * shader does the rest per pixel on the GPU: starfield, atmosphere halo,
 * shaded ocean, land/coast/border colours, graticule, a smooth day/night
 * terminator and the limb. Markers, arcs and labels stay on the 2D overlay.
 *
 * createGlobeGL(canvas) -> null if WebGL is unavailable, else
 *   { setLand(world), setStars(canvas), render(p), resize(w, h), info }
 */
(function () {
  'use strict';

  const VS = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

  // GLSL ES 1.0 so it runs on WebGL1 as well as WebGL2.
  const FS = `
#ifdef GL_OES_standard_derivatives
#extension GL_OES_standard_derivatives : enable
#endif
precision highp float;
uniform vec2 uRes;        // drawing-buffer size, px
uniform vec2 uC;          // globe centre, px, top-left origin
uniform float uR;         // globe radius, px
uniform mat3 uRot;        // view (x right, y up, z toward viewer) -> world
uniform vec3 uSun;        // world unit vector toward the sun
uniform vec2 uStarOff;    // starfield pan, px
uniform float uPx;        // device px per CSS px (line widths)
uniform sampler2D uLand;  // r = land coverage, g = borders, b = coastline
uniform sampler2D uStars;
uniform float uHasDeriv;

const float PI = 3.14159265;
const vec3 SPACE = vec3(0.0196, 0.0275, 0.051);

float gridLine(float deg, float step, float pxPerDeg) {
  float d = abs(mod(deg + step * 0.5, step) - step * 0.5) * pxPerDeg;  // distance in px
  return 1.0 - smoothstep(0.35 * uPx, 1.1 * uPx, d);
}

void main() {
  vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 d = (frag - uC) / uR;
  float r2 = dot(d, d);
  float r = sqrt(r2);

  // Stars (texture holds one screen; wrap it by hand - NPOT textures can't REPEAT in WebGL1).
  vec3 col = texture2D(uStars, fract((frag + uStarOff) / uRes)).rgb;

  // Atmosphere halo: 0.28 at the limb, 0.08 a third of the way out, 0 at 1.22R.
  if (r > 0.96 && r < 1.22) {
    float t = (r - 0.96) / 0.26;
    float a = t < 0.35 ? mix(0.28, 0.08, t / 0.35) : mix(0.08, 0.0, (t - 0.35) / 0.65);
    col = mix(col, vec3(0.2196, 0.7412, 0.9725), a);
  }

  if (r2 < 1.0) {
    vec3 pv = vec3(d.x, -d.y, sqrt(1.0 - r2));
    vec3 w = uRot * pv;
    float lat = asin(clamp(w.z, -1.0, 1.0));
    float lon = atan(w.y, w.x);
    vec2 uv = vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);

    // Ocean: offset radial shading so it reads as a sphere, not a disc.
    float ot = clamp((length(d - vec2(-0.32, -0.44)) - 0.05) / 1.38, 0.0, 1.0);
    vec3 ocean = ot < 0.62 ? mix(vec3(0.106, 0.161, 0.259), vec3(0.059, 0.090, 0.165), ot / 0.62)
                           : mix(vec3(0.059, 0.090, 0.165), vec3(0.031, 0.051, 0.094), (ot - 0.62) / 0.38);
    vec3 g = ocean;

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

    vec3 L = texture2D(uLand, uv).rgb;
    g = mix(g, vec3(0.141, 0.204, 0.294), L.r);                 // land #24344b
    g = mix(g, vec3(0.431, 0.549, 0.725), L.b * 0.55);          // coastline
    g = mix(g, vec3(0.282, 0.376, 0.518), L.g);                 // borders #486084

    // Night: a smooth terminator, darkest about 18 degrees past it.
    float s = dot(w, uSun);
    g *= 1.0 - 0.5 * smoothstep(0.09, -0.3, s);

    // Limb line, antialiased, 1.2 css px.
    float edge = (1.0 - r) * uR;
    float limb = 1.0 - smoothstep(0.0, 1.2 * uPx, edge);
    g = mix(g, vec3(0.2196, 0.7412, 0.9725), limb * 0.45);

    // Antialias the disc edge against the halo.
    float cover = clamp((1.0 - r) * uR + 0.5, 0.0, 1.0);
    col = mix(col, g, cover);
  }
  gl_FragColor = vec4(col, 1.0);
}`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader compile failed');
    return s;
  }

  window.createGlobeGL = function (canvas) {
    let gl = null;
    const opts = { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'high-performance' };
    try { gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts); } catch (_) { gl = null; }
    if (!gl) return null;

    const hasDeriv = !!gl.getExtension('OES_standard_derivatives');
    let prog;
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link failed');
    } catch (e) {
      console.warn('[globe] WebGL shader failed, using 2D', e);
      return null;
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const U = {};
    for (const n of ['uRes', 'uC', 'uR', 'uRot', 'uSun', 'uStarOff', 'uPx', 'uLand', 'uStars', 'uHasDeriv']) U[n] = gl.getUniformLocation(prog, n);
    gl.uniform1i(U.uLand, 0);
    gl.uniform1i(U.uStars, 1);
    gl.uniform1f(U.uHasDeriv, hasDeriv ? 1 : 0);

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

    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    let renderer = '';
    try {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    } catch (_) { /* */ }

    /** Bake land into an equirectangular texture: coverage in red, borders in
     *  green, coastline in blue, so the shader picks the colours. Built once. */
    function setLand(land, borders, width) {
      const W = Math.min(width || 4096, maxTex), H = W / 2;
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
      const proj = d3.geoEquirectangular().scale(W / (2 * Math.PI)).translate([W / 2, H / 2]).precision(0.1);
      const p = d3.geoPath(proj, g);
      g.lineJoin = 'round';
      g.fillStyle = '#f00'; g.beginPath(); p(land); g.fill();
      g.globalCompositeOperation = 'lighter';
      const lw = Math.max(1, W / 4096) * 1.25;
      g.strokeStyle = '#0000ff'; g.lineWidth = lw * 1.1; g.beginPath(); p(land); g.stroke();
      g.strokeStyle = '#00ff00'; g.lineWidth = lw; g.beginPath(); p(borders); g.stroke();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, landTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
      return W;
    }

    function setStars(starCanvas) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, starTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, starCanvas);
    }

    function resize(w, h) {
      canvas.width = w; canvas.height = h;
      gl.viewport(0, 0, w, h);
    }

    /** p: { cx, cy, R, lon, lat, sun:[x,y,z], starX, starY, px } in drawing-buffer px. */
    function render(p) {
      const l = p.lon * Math.PI / 180, f = p.lat * Math.PI / 180;
      const sl = Math.sin(l), cl = Math.cos(l), sf = Math.sin(f), cf = Math.cos(f);
      // Columns: east, north, centre (view x, y, z in world coordinates).
      const rot = new Float32Array([-sl, cl, 0, -sf * cl, -sf * sl, cf, cf * cl, cf * sl, sf]);
      gl.uniform2f(U.uRes, canvas.width, canvas.height);
      gl.uniform2f(U.uC, p.cx, p.cy);
      gl.uniform1f(U.uR, p.R);
      gl.uniformMatrix3fv(U.uRot, false, rot);
      gl.uniform3f(U.uSun, p.sun[0], p.sun[1], p.sun[2]);
      gl.uniform2f(U.uStarOff, p.starX, p.starY);
      gl.uniform1f(U.uPx, p.px);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    return { setLand, setStars, render, resize, info: { renderer, maxTex, deriv: hasDeriv } };
  };
})();
