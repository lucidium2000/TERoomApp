// Part of TERoomApp - created by Christopher Hunt (github.com/lucidium2000).
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
uniform sampler2D uReg;   // regional high-res radar (NOAA MRMS over North America)
uniform sampler2D uRegB;  // its next frame, while animating
uniform vec4 uRegBox;     // its bounds: west, south, east, north (degrees)
uniform float uRegOn;     // 1 when the regional frames are loaded
uniform sampler2D uDet;   // detail regions (radar.js DETAIL) packed in one atlas
uniform sampler2D uDetB;  // its next frame, while animating
uniform vec4 uDetBox[5];  // each region: west, south, east, north
uniform vec4 uDetRect[5]; // where it sits in the atlas: u0, v0, u1, v1
uniform float uDetHasA[5], uDetHasB[5];   // this frame / the next has that region yet
uniform float uDetOn;
#ifdef FX
uniform sampler2D uLights; // city lights at night (NASA Black Marble, luminance)
uniform sampler2D uAur;    // aurora probability (NOAA SWPC OVATION, 360x181)
uniform vec4 uFx;          // lights on, aurora on, sun glint on, time (s)
#endif

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

    float landV = landAt(uv);
    g = mix(g, vec3(0.141, 0.204, 0.294), landV);               // land #24344b

#ifdef FX
    // Sun glint: the sun's reflection off open water, where it would really be.
    if (uFx.z > 0.0) {
      vec3 vv = normalize(uEye - hit);
      vec3 hv = normalize(uSun + uRot * vec3(vv.x, -vv.y, -vv.z));
      float hd = max(dot(w, hv), 0.0);
      g += vec3(1.0, 0.94, 0.82) * (pow(hd, 110.0) * 0.32 + pow(hd, 14.0) * 0.045) * (1.0 - landV) * smoothstep(-0.05, 0.3, dot(w, uSun)) * uFx.z;
    }
#endif

    // Night: a smooth terminator, darkest about 18 degrees past it.
    g *= 1.0 - 0.5 * smoothstep(0.09, -0.3, dot(w, uSun));

#ifdef FX
    float nightF = smoothstep(0.06, -0.22, dot(w, uSun));
    // City lights fade in as the terminator passes.
    if (uFx.x > 0.0 && nightF > 0.0) {
      float lt = texture2D(uLights, uv).r;
      g += (vec3(1.0, 0.72, 0.36) * lt * lt * 1.25 + vec3(1.0, 0.82, 0.55) * lt * 0.10) * nightF * uFx.x;
    }
    // Aurora: green curtains (violet where strongest) that drift and flicker.
    if (uFx.y > 0.0) {
      float A = texture2D(uAur, uv).r;
      if (A > 0.004) {
        float t = uFx.w;
        float curtain = 0.55 + 0.45 * sin(lonDeg * 0.9 + t * 0.6 + 3.0 * sin(lonDeg * 0.13 - t * 0.21));
        float flick = 0.85 + 0.15 * sin(t * 2.1 + lonDeg * 1.7 + latDeg * 0.9);
        vec3 ac = mix(vec3(0.15, 1.0, 0.55), vec3(0.62, 0.38, 1.0), smoothstep(0.35, 0.95, A));
        g += ac * smoothstep(0.0, 0.45, A) * curtain * flick * 0.3 * mix(0.2, 1.0, nightF) * uFx.y;
      }
    }
#endif

    // Weather radar, over day and night alike (storms matter at night too).
    // Textures are premultiplied (no light fringes where rain meets clear).
    // Inside the regional box its sharper data replaces the global layer,
    // feathered over the box's outer edge.
    if (uRadarA > 0.0) {
      vec4 rd = texture2D(uRadar, uv);
      if (uRadarMix > 0.0) rd = mix(rd, texture2D(uRadarB, uv), uRadarMix);
      if (uRegOn > 0.0) {
        vec2 ruv = vec2((lonDeg - uRegBox.x) / (uRegBox.z - uRegBox.x), (uRegBox.w - latDeg) / (uRegBox.w - uRegBox.y));
        vec2 e = min(ruv, 1.0 - ruv);
        float inR = smoothstep(0.0, 0.04, min(e.x, e.y));
        // NOAA has no radar for Mexico, Cuba or the Bahamas: there, keep the
        // world layer (and the Mexico detail) instead of NOAA's blank.
        // The US's southern edge (the Mexican border, then the Gulf and the
        // Florida Keys) as a latitude for each longitude.
        float bLat;
        if (lonDeg < -114.8) bLat = 32.5;
        else if (lonDeg < -111.0) bLat = mix(32.5, 31.33, (lonDeg + 114.8) / 3.8);
        else if (lonDeg < -108.2) bLat = 31.33;
        else if (lonDeg < -106.5) bLat = 31.8;
        else if (lonDeg < -101.0) bLat = mix(31.8, 29.4, (lonDeg + 106.5) / 5.5);
        else if (lonDeg < -97.2) bLat = mix(29.4, 25.9, (lonDeg + 101.0) / 3.8);
        else if (lonDeg < -83.0) bLat = 25.6;
        else bLat = 24.3;
        inR *= smoothstep(bLat - 1.2, bLat + 0.6, latDeg);   // 0 south of it
        vec2 cuv = clamp(ruv, 0.0, 1.0);
        vec4 rr = texture2D(uReg, cuv);
        if (uRadarMix > 0.0) rr = mix(rr, texture2D(uRegB, cuv), uRadarMix);
        // In the seam (the box's feathered edge, the border band) show both
        // layers - NOAA over the world - so the two sources' small
        // disagreements don't cut a cell off with a straight line.
        vec4 ov = rr + rd * (1.0 - rr.a);
        rd = mix(mix(rd, ov, smoothstep(0.0, 0.3, inR)), rr, smoothstep(0.55, 1.0, inR));
      }
      if (uDetOn > 0.0) {
        for (int i = 0; i < 5; i++) {
          vec4 bx = uDetBox[i], rc = uDetRect[i];
          vec2 q = vec2((lonDeg - bx.x) / (bx.z - bx.x), (bx.w - latDeg) / (bx.w - bx.y));
          vec2 e2 = min(q, 1.0 - q);
          float inD = smoothstep(0.0, 0.06, min(e2.x, e2.y));
          vec2 auv = mix(rc.xy, rc.zw, clamp(q, 0.0, 1.0));
          // Each frame's detail replaces its own share of the blend; a frame
          // whose detail hasn't arrived yet keeps the world layer.
          float wA = uDetHasA[i] * (1.0 - uRadarMix), wB = uDetHasB[i] * uRadarMix;
          if (wA + wB <= 0.0) continue;
          vec4 dd = texture2D(uDet, auv) * wA + texture2D(uDetB, auv) * wB;
          rd = rd * (1.0 - inD * (wA + wB)) + dd * inD;
        }
      }
      g = g * (1.0 - rd.a * uRadarA) + rd.rgb * uRadarA;
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

  // ── FX preview (?fx=1) ─────────────────────────────────────────────────
  // Shared: put a world-space point (unit sphere = the surface) on the glass,
  // hidden when the Earth is in the way.
  const FX_PLACE = `
uniform mat3 uRot;
uniform vec2 uRes;
uniform vec3 uEye, uCtr;
uniform float uRw;
vec4 place(vec3 wp, out float vis) {
  vec3 v = wp * uRot;
  vec3 h = uCtr + uRw * vec3(v.x, -v.y, -v.z);
  vec3 d = h - uEye, oc = uEye - uCtr;
  float a = dot(d, d), b = dot(oc, d), c = dot(oc, oc) - uRw * uRw * 0.999;
  float disc = b * b - a * c;
  vis = h.z > uEye.z + 1.0 ? 1.0 : 0.0;   // never behind the viewer's eye
  if (disc > 0.0) { float t = (-b - sqrt(disc)) / a; if (t > 0.0 && t < 1.0) vis = 0.0; }
  float s = -uEye.z / (h.z - uEye.z);
  vec2 p = uEye.xy + (h.xy - uEye.xy) * s;
  return vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0);
}`;

  // Undersea cables: faint lines with pulses of light running along them;
  // cables landing near an active outage turn orange and pulse faster.
  const CABLE_VS = `
attribute vec3 aP;
attribute float aD, aH;
${FX_PLACE}
varying float vZ, vD, vH;
void main() {
  float vis;
  gl_Position = place(aP, vis);
  vec3 v = aP * uRot;
  vec3 h = uCtr + uRw * vec3(v.x, -v.y, -v.z);
  vZ = dot(vec3(v.x, -v.y, -v.z), normalize(uEye - h));
  vD = aD; vH = aH;
}`;
  const CABLE_FS = `
precision highp float;
uniform float uT;
varying float vZ, vD, vH;
void main() {
  if (vZ < 0.0) discard;
  float fade = smoothstep(0.0, 0.05, vZ);
  float p = fract(vD * 3.0 - uT * (0.045 + vH * 0.08));
  float head = smoothstep(0.93, 0.995, p) * (1.0 - smoothstep(0.995, 1.0, p));
  float tail = smoothstep(0.6, 0.99, p) * 0.3;
  vec3 base = mix(vec3(0.24, 0.72, 0.95), vec3(1.0, 0.48, 0.22), vH);
  float a = 0.2 + vH * 0.25 + head * 0.8 + tail * 0.35;
  gl_FragColor = vec4(base * (0.8 + head * 0.9 + tail * 0.4) + vec3(head * 0.45), a * fade);
}`;

  // Points (soft dots or rings) and lines, with their own colour and size.
  const PT_VS = `
attribute vec3 aP;
attribute vec4 aC;
attribute float aS;
${FX_PLACE}
varying vec4 vC;
void main() {
  float vis;
  gl_Position = place(aP, vis);
  vC = vec4(aC.rgb, aC.a * vis);
  gl_PointSize = aS;
}`;
  const PT_FS = `
precision mediump float;
uniform float uMode;   // 0 soft dot, 1 ring, 2 line
varying vec4 vC;
void main() {
  if (vC.a <= 0.003) discard;
  float a = vC.a;
  if (uMode < 1.5) {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    a *= uMode < 0.5 ? pow(1.0 - d, 1.6) : smoothstep(0.62, 0.86, d) * (1.0 - smoothstep(0.9, 1.0, d));
  }
  gl_FragColor = vec4(vC.rgb, a);
}`;

  // Satellites flown on the GPU from their orbital elements (circular orbits
  // with the Earth's-oblateness drift of the node), lit only in sunlight.
  const SAT_VS = `
attribute vec4 aA;   // mean motion (rad/s), inclination, node at t=0, node drift (rad/s)
attribute vec4 aB;   // argument of latitude at t=0, its rate (rad/s), orbit radius (Earth radii), spare
uniform float uT, uGmst, uPx;
uniform vec3 uSun;
${FX_PLACE}
varying vec4 vC;
void main() {
  float O = aA.z + aA.w * uT - uGmst;
  float u = aB.x + aB.y * uT;
  float ci = cos(aA.y), si = sin(aA.y), cO = cos(O), sO = sin(O), cu = cos(u), su = sin(u);
  vec3 p = vec3(cO * cu - sO * su * ci, sO * cu + cO * su * ci, su * si) * aB.z;
  float vis;
  gl_Position = place(p, vis);
  float sd = dot(p, uSun);
  float lit = (sd > 0.0 || length(p - sd * uSun) > 1.0) ? 1.0 : 0.0;
  vC = vec4(mix(vec3(0.42, 0.52, 0.68), vec3(0.86, 0.95, 1.0), lit), vis * mix(0.16, 0.8, lit));
  gl_PointSize = mix(1.7, 2.5, lit) * uPx;
  if (vis < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
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

  window.createGlobeGL = function (canvas, gopts) {
    const FX = !!(gopts && gopts.fx);
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
    // FX needs two more texture units (lights, aurora) than the regular 8.
    let fxTex = FX && gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) >= 10;
    let fxProgs = null;
    try {
      // The FX shader is the regular one plus extras; if a device can't build it, keep the regular one.
      // The define goes after the #extension lines: some browsers (Firefox) only honour them first.
      if (fxTex) { try { quadProg = program(gl, QUAD_VS, QUAD_FS.replace('precision highp float;', '#define FX 1\nprecision highp float;')); } catch (e) { console.warn('[globe] FX globe shader failed', e); fxTex = false; } }
      if (!quadProg) quadProg = program(gl, QUAD_VS, QUAD_FS);
      lineProg = program(gl, LINE_VS, LINE_FS);
      if (FX) {
        try { fxProgs = { cable: program(gl, CABLE_VS, CABLE_FS), pt: program(gl, PT_VS, PT_FS), sat: program(gl, SAT_VS, PT_FS) }; }
        catch (e) { console.warn('[globe] FX shaders failed', e); fxProgs = null; }
      }
    } catch (e) {
      console.warn('[globe] WebGL shader failed, using 2D', e);
      return null;
    }

    const quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const Q = { aPos: gl.getAttribLocation(quadProg, 'aPos') };
    for (const n of ['uRes', 'uEye', 'uCtr', 'uRw', 'uR', 'uRot', 'uSun', 'uStarOff', 'uPx', 'uLand', 'uStars', 'uRadar', 'uRadarB', 'uRadarMix', 'uRadarA', 'uReg', 'uRegB', 'uRegBox', 'uRegOn', 'uDet', 'uDetB', 'uDetBox', 'uDetRect', 'uDetOn', 'uDetHasA', 'uDetHasB']) Q[n] = gl.getUniformLocation(quadProg, n);
    const Lu = { aP: gl.getAttribLocation(lineProg, 'aP') };
    for (const n of ['uRot', 'uRes', 'uEye', 'uCtr', 'uRw', 'uColor', 'uSun']) Lu[n] = gl.getUniformLocation(lineProg, n);
    gl.useProgram(quadProg);
    gl.uniform1i(Q.uLand, 0);
    gl.uniform1i(Q.uStars, 1);
    gl.uniform1i(Q.uRadar, 2);
    gl.uniform1i(Q.uRadarB, 3);
    gl.uniform1i(Q.uReg, 4);
    gl.uniform1i(Q.uRegB, 5);
    gl.uniform1i(Q.uDet, 6);
    gl.uniform1i(Q.uDetB, 7);
    if (fxTex) {
      for (const n of ['uLights', 'uAur', 'uFx']) Q[n] = gl.getUniformLocation(quadProg, n);
      gl.uniform1i(Q.uLights, 8);
      gl.uniform1i(Q.uAur, 9);
    }

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
    const lightsTex = fxTex ? makeTex(8) : null, aurTex = fxTex ? makeTex(9) : null;
    // Radar frames: one texture per image, kept while that image is shown, so
    // a loop that grows a frame at a time uploads each frame only once.
    const blankTex = makeTex(2);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    let radarTexs = [blankTex], radarByImg = new Map();
    let regTexs = [blankTex], regByImg = new Map(), regOn = false, regBox = [-130, 20, -60, 55];
    let detTexs = [blankTex], detByImg = new Map(), detOn = false, detLayout = null, detHas = [];
    let detBoxes = new Float32Array(20), detRects = new Float32Array(20);
    const hasVec = (m) => { const v = new Float32Array(5); (m || []).forEach((x, i) => { if (i < 5) v[i] = x ? 1 : 0; }); return v; };
    let radarA = 0, radarCur = 0, radarNext = 0, radarMix = 0;
    let statesOn = false;   // state lines without the radar (the power layer)

    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const FIREFOX = /firefox/i.test(navigator.userAgent);
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
          // Firefox (real GPU) can hand back a blank canvas this big without
          // an error, so the globe went plain once the map loaded. Check a few
          // inland points; if they're empty, try the next size down.
          const inland = [[20, 5], [100, 60], [-100, 40], [-60, -10], [135, -25]];
          const hits = inland.filter(([lo, la]) => { const [x, y] = proj([lo, la]); return g.getImageData(x | 0, y | 0, 1, 1).data[0] > 127; }).length;
          if (hits < 3) throw new Error('land canvas came out blank at ' + W);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, landTex);
          if (FIREFOX) {
            // Upload from pixel data in strips instead of straight from the
            // canvas (Firefox's canvas-to-texture path drops it on some GPUs).
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, W, H, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, null);
            const S = 256, row = new Uint8Array(W * S);
            for (let y0 = 0; y0 < H; y0 += S) {
              const d = g.getImageData(0, y0, W, S).data;
              for (let i = 0, j = 0; i < row.length; i++, j += 4) row[i] = d[j];
              gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y0, W, S, gl.LUMINANCE, gl.UNSIGNED_BYTE, row);
            }
          } else {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, gl.LUMINANCE, gl.UNSIGNED_BYTE, c);
          }
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
    /** One texture per image, reusing those already uploaded. */
    function syncTexs(imgs, byImg) {
      const next = new Map();
      for (const img of imgs || []) {
        if (!img || next.has(img)) continue;
        let t = byImg.get(img);
        if (!t) {
          t = makeTex(2);
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
          // Mipmaps (the frames are powers of two): no shimmer zoomed out.
          if (!(img.width & (img.width - 1)) && !(img.height & (img.height - 1))) {
            gl.generateMipmap(gl.TEXTURE_2D);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
          }
        }
        next.set(img, t);
      }
      for (const [img, t] of byImg) if (!next.has(img)) gl.deleteTexture(t);
      const texs = (imgs || []).map((img) => next.get(img) || blankTex);
      return { texs: texs.length ? texs : [blankTex], byImg: next };
    }
    /** Several radar frames (oldest first) for animation; null clears.
     *  regs (optional): the matching regional frames, inside box [w, s, e, n]. */
    function setRadarFrames(imgs, alpha, regs, box, dets, layout, masks) {
      const a = syncTexs(imgs, radarByImg);
      radarTexs = a.texs; radarByImg = a.byImg;
      const useReg = !!(imgs && regs && regs.length === imgs.length && regs.every(Boolean));
      const b = syncTexs(useReg ? regs : null, regByImg);
      regTexs = b.texs; regByImg = b.byImg; regOn = useReg;
      // Detail may be missing for some frames while it loads: those keep the world layer.
      const useDet = !!(imgs && dets && layout && layout.length && dets.length === imgs.length && dets.some(Boolean));
      const c = syncTexs(useDet ? dets : null, detByImg);
      detTexs = c.texs; detByImg = c.byImg; detOn = useDet;
      // Per frame, which regions it has: [frame][region] -> 0/1.
      detHas = useDet ? dets.map((d, k) => (d ? (masks && masks[k]) || layout.map(() => true) : [])) : [];
      if (layout) {
        detLayout = layout.slice(0, 5);
        detBoxes = new Float32Array(20); detRects = new Float32Array(20);
        detLayout.forEach((r, i) => { detBoxes.set(r.box, i * 4); detRects.set(r.rect, i * 4); });
      }
      if (box) regBox = box;
      radarCur = radarNext = radarTexs.length - 1; radarMix = 0;
      radarA = imgs === null ? 0 : alpha != null ? alpha : radarA;
    }
    /** Show frame a, crossfading toward frame b by t (0..1). */
    function setRadarPos(a, b, t) { radarCur = a; radarNext = b; radarMix = t; }

    // ── FX preview state ────────────────────────────────────────────────
    const fx = {
      on: { lights: false, aurora: false, glint: false, cables: false, quakes: false, sats: false, comets: false },
      t0: performance.now(),
      cableBuf: null, cableHotBuf: null, cableCount: 0, cableOf: null, cableN: 0,
      satBuf: null, satCount: 0, satRef: 0,
      quakes: [], comets: [],
      dynBuf: null,
    };
    const C = {}, Pt = {}, Sa = {};
    if (fxProgs) {
      C.aP = gl.getAttribLocation(fxProgs.cable, 'aP'); C.aD = gl.getAttribLocation(fxProgs.cable, 'aD'); C.aH = gl.getAttribLocation(fxProgs.cable, 'aH');
      for (const n of ['uRot', 'uRes', 'uEye', 'uCtr', 'uRw', 'uT']) C[n] = gl.getUniformLocation(fxProgs.cable, n);
      Pt.aP = gl.getAttribLocation(fxProgs.pt, 'aP'); Pt.aC = gl.getAttribLocation(fxProgs.pt, 'aC'); Pt.aS = gl.getAttribLocation(fxProgs.pt, 'aS');
      for (const n of ['uRot', 'uRes', 'uEye', 'uCtr', 'uRw', 'uMode']) Pt[n] = gl.getUniformLocation(fxProgs.pt, n);
      Sa.aA = gl.getAttribLocation(fxProgs.sat, 'aA'); Sa.aB = gl.getAttribLocation(fxProgs.sat, 'aB');
      for (const n of ['uRot', 'uRes', 'uEye', 'uCtr', 'uRw', 'uT', 'uGmst', 'uPx', 'uSun', 'uMode']) Sa[n] = gl.getUniformLocation(fxProgs.sat, n);
    }
    const RADd = Math.PI / 180;
    const uv3 = (lo, la, r = 1) => { const l = lo * RADd, p = la * RADd, c = Math.cos(p); return [r * c * Math.cos(l), r * c * Math.sin(l), r * Math.sin(p)]; };
    /** Greenwich sidereal angle (radians) at ms. */
    const gmst = (ms) => { const d = ms / 86400000 + 2440587.5 - 2451545.0; return (((280.46061837 + 360.98564736629 * d) % 360) + 360) % 360 * RADd; };

    const fxApi = {
      available: !!fxProgs, textures: fxTex,
      enable(flags) { Object.assign(fx.on, flags); },
      /** City lights: an equirectangular image (white = lit). */
      setLights(img) {
        if (!fxTex) return;
        gl.activeTexture(gl.TEXTURE8); gl.bindTexture(gl.TEXTURE_2D, lightsTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, gl.LUMINANCE, gl.UNSIGNED_BYTE, img);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      },
      /** Aurora: 360x181 bytes, row 0 = 90N, column 0 = 180W. */
      setAurora(bytes) {
        if (!fxTex) return;
        gl.activeTexture(gl.TEXTURE9); gl.bindTexture(gl.TEXTURE_2D, aurTex);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 360, 181, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, bytes);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      },
      /** Cables: [[name, [lon, lat, lon, lat, ...]], ...]. Long segments follow the great circle. */
      setCables(list) {
        if (!fxProgs) return;
        const P = [], D = [], of = [];
        list.forEach(([, flat], ci) => {
          let dist = Math.random() * 3, prev = null;
          const pts = [];
          for (let i = 0; i + 1 < flat.length; i += 2) pts.push(uv3(flat[i], flat[i + 1]));
          for (let i = 0; i + 1 < pts.length; i++) {
            const a = pts[i], b = pts[i + 1];
            const ang = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
            const n = Math.max(1, Math.ceil(ang / (1.5 * RADd)));
            for (let k = 0; k < n; k++) {
              const s0 = Math.sin(ang), f = (t) => (s0 < 1e-6 ? [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
                : (() => { const wa = Math.sin((1 - t) * ang) / s0, wb = Math.sin(t * ang) / s0; return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb]; })());
              const p0 = f(k / n), p1 = f((k + 1) / n);
              P.push(...p0, ...p1); D.push(dist, dist + ang / n); dist += ang / n; of.push(ci, ci);
            }
            prev = b;
          }
        });
        fx.cableCount = P.length / 3; fx.cableOf = Int32Array.from(of); fx.cableN = list.length;
        fx.cableBuf = fx.cableBuf || gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, fx.cableBuf);
        const inter = new Float32Array(fx.cableCount * 4);
        for (let i = 0; i < fx.cableCount; i++) { inter[i * 4] = P[i * 3]; inter[i * 4 + 1] = P[i * 3 + 1]; inter[i * 4 + 2] = P[i * 3 + 2]; inter[i * 4 + 3] = D[i]; }
        gl.bufferData(gl.ARRAY_BUFFER, inter, gl.STATIC_DRAW);
        fxApi.setCableHot(new Set());
      },
      /** Which cables (by index) run near an active outage. */
      setCableHot(hot) {
        if (!fxProgs || !fx.cableOf) return;
        const h = new Float32Array(fx.cableCount);
        for (let i = 0; i < fx.cableCount; i++) if (hot.has(fx.cableOf[i])) h[i] = 1;
        fx.cableHotBuf = fx.cableHotBuf || gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, fx.cableHotBuf);
        gl.bufferData(gl.ARRAY_BUFFER, h, gl.STATIC_DRAW);
      },
      /** Satellites: [[epochSec, revPerDay, ecc, incDeg, raanDeg, argpDeg, meanAnomDeg], ...]. */
      setSats(list) {
        if (!fxProgs) return;
        const { arr, ref } = fxApi.elements(list);
        fx.satEl = arr; fx.satRef = ref; fx.satCount = list.length;
        fx.satBuf = fx.satBuf || gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, fx.satBuf);
        gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
      },
      /** The loaded satellites' elements (8 floats each, as the shader reads them) and their time base. */
      satEls: () => ({ arr: fx.satEl || null, ref: fx.satRef, n: fx.satCount }),
      gmst,
      /** Elements -> per satellite [n, inc, node0, node drift, arg. of latitude0, its rate, radius (Earth radii), 0] at t = now. */
      elements(list) {
        const MU = 398600.4418, RE = 6378.137, J2 = 1.08263e-3, now = Date.now() / 1000;
        const arr = new Float32Array(list.length * 8);
        let k = 0;
        for (const [ep, rev, e, incD, raanD, argpD, maD] of list) {
          const n = rev * 2 * Math.PI / 86400, a = Math.cbrt(MU / (n * n)), inc = incD * RADd, ci = Math.cos(inc);
          const q = 1.5 * J2 * (RE / (a * (1 - e * e))) ** 2;
          const raanDot = -q * n * ci, argpDot = 0.5 * q * n * (5 * ci * ci - 1), maDot = n * (1 + 0.5 * q * Math.sqrt(1 - e * e) * (3 * ci * ci - 1));
          const dt = now - ep, uDot = maDot + argpDot;
          const u0 = ((argpD + maD) * RADd + uDot * dt) % (2 * Math.PI), O0 = (raanD * RADd + raanDot * dt) % (2 * Math.PI);
          arr.set([n, inc, O0, raanDot, u0, uDot, a / RE, 0], k); k += 8;
        }
        return { arr, ref: now };
      },
      /** Earthquakes: [{ lon, lat, mag, time }]. */
      setQuakes(list) { fx.quakes = list || []; },
      /** A streak from space onto a point (a new outage), then a flash. */
      _state: fx,
      _dbg: () => ({ Pt: Object.fromEntries(Object.entries(Pt).map(([k, v]) => [k, v === null ? null : typeof v === 'number' ? v : 'loc'])), Sa: Object.fromEntries(Object.entries(Sa).map(([k, v]) => [k, v === null ? null : typeof v === 'number' ? v : 'loc'])) }),
      comet(lon, lat, rgb) { if (fx.comets.length < 6) fx.comets.push({ lon, lat, rgb: rgb || [1, 0.6, 0.3], t0: performance.now(), dir: Math.random() * Math.PI * 2 }); },
    };

    const maxAttr = Math.min(16, gl.getParameter(gl.MAX_VERTEX_ATTRIBS));
    const clearAttribs = () => { for (let i = 0; i < maxAttr; i++) gl.disableVertexAttribArray(i); };
    function setCommon(U, rot, p) {
      clearAttribs();
      gl.uniformMatrix3fv(U.uRot, false, rot);
      gl.uniform2f(U.uRes, canvas.width, canvas.height);
      gl.uniform3f(U.uEye, p.eye[0], p.eye[1], p.eye[2]);
      gl.uniform3f(U.uCtr, p.ctr[0], p.ctr[1], p.ctr[2]);
      gl.uniform1f(U.uRw, p.Rw);
    }
    /** Interleaved [x, y, z, r, g, b, a, size] vertices through the point/line program. */
    function drawDyn(data, mode, prim, rot, p) {
      if (!data.length) return;
      gl.useProgram(fxProgs.pt);
      setCommon(Pt, rot, p);
      gl.uniform1f(Pt.uMode, mode);
      fx.dynBuf = fx.dynBuf || gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, fx.dynBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(Pt.aP); gl.vertexAttribPointer(Pt.aP, 3, gl.FLOAT, false, 32, 0);
      gl.enableVertexAttribArray(Pt.aC); gl.vertexAttribPointer(Pt.aC, 4, gl.FLOAT, false, 32, 12);
      gl.enableVertexAttribArray(Pt.aS); gl.vertexAttribPointer(Pt.aS, 1, gl.FLOAT, false, 32, 28);
      gl.drawArrays(prim, 0, data.length / 8);
    }
    function renderFx(rot, p) {
      const tS = (performance.now() - fx.t0) / 1000, px = p.px || 1;
      gl.enable(gl.BLEND);
      // Cables.
      if (fx.on.cables && fx.cableBuf && fx.cableHotBuf) {
        gl.useProgram(fxProgs.cable);
        setCommon(C, rot, p);
        gl.uniform1f(C.uT, tS % 100000);
        gl.bindBuffer(gl.ARRAY_BUFFER, fx.cableBuf);
        gl.enableVertexAttribArray(C.aP); gl.vertexAttribPointer(C.aP, 3, gl.FLOAT, false, 16, 0);
        gl.enableVertexAttribArray(C.aD); gl.vertexAttribPointer(C.aD, 1, gl.FLOAT, false, 16, 12);
        gl.bindBuffer(gl.ARRAY_BUFFER, fx.cableHotBuf);
        gl.enableVertexAttribArray(C.aH); gl.vertexAttribPointer(C.aH, 1, gl.FLOAT, false, 0, 0);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArrays(gl.LINES, 0, fx.cableCount);
      }
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);   // glows add up
      // Earthquakes: a dot, and rings that ripple out every few seconds (fainter with age).
      if (fx.on.quakes && fx.quakes.length) {
        const dots = [], rings = [], nowMs = Date.now();
        for (const q of fx.quakes) {
          const age = Math.max(0, (nowMs - q.time) / 3600000), fade = Math.max(0.25, 1 - age / 30);
          const [x, y, z] = uv3(q.lon, q.lat, 1.001), m = Math.max(2.5, q.mag);
          dots.push(x, y, z, 1, 0.86, 0.45, 0.75 * fade, (3 + m * 1.4) * px);
          const per = 3.2, ph = ((tS + (q.time % 9973) / 1000) % per) / per;
          rings.push(x, y, z, 1, 0.84, 0.42, (1 - ph) * 0.85 * fade, (6 + (m - 2) * 9 * ph + ph * 10) * px);
        }
        drawDyn(dots, 0, gl.POINTS, rot, p);
        drawDyn(rings, 1, gl.POINTS, rot, p);
      }
      // Starlink.
      if (fx.on.sats && fx.satBuf && fx.satCount) {
        gl.useProgram(fxProgs.sat);
        setCommon(Sa, rot, p);
        gl.uniform1f(Sa.uT, Date.now() / 1000 - fx.satRef);
        gl.uniform1f(Sa.uGmst, gmst(Date.now()));
        gl.uniform1f(Sa.uPx, px);
        gl.uniform1f(Sa.uMode, 0);
        gl.uniform3f(Sa.uSun, p.sun[0], p.sun[1], p.sun[2]);
        gl.bindBuffer(gl.ARRAY_BUFFER, fx.satBuf);
        gl.enableVertexAttribArray(Sa.aA); gl.vertexAttribPointer(Sa.aA, 4, gl.FLOAT, false, 32, 0);
        gl.enableVertexAttribArray(Sa.aB); gl.vertexAttribPointer(Sa.aB, 4, gl.FLOAT, false, 32, 16);
        gl.drawArrays(gl.POINTS, 0, fx.satCount);
      }
      // Comets: 1.3 s in from space, a bright head and a fading tail, then a flash.
      if (fx.on.comets && fx.comets.length) {
        const nowP = performance.now(), lines = [], heads = [], flashes = [];
        fx.comets = fx.comets.filter((c) => nowP - c.t0 < 3000);
        for (const c of fx.comets) {
          const T = (nowP - c.t0) / 1700;
          const end = uv3(c.lon, c.lat, 1.0);
          // Start 22 degrees away, a third of an Earth radius up.
          const sLon = c.lon + 22 * Math.cos(c.dir), sLat = Math.max(-80, Math.min(80, c.lat + 16 * Math.sin(c.dir)));
          const at = (u) => { const e = u * u * (3 - 2 * u) * 0.6 + u * 0.4, lo = sLon + (c.lon - sLon) * e, la = sLat + (c.lat - sLat) * e; return uv3(lo, la, 1.002 + 0.33 * (1 - e)); };
          const [r, g, b] = c.rgb;
          if (T < 1) {
            const N = 26;
            for (let i = 0; i < N; i++) {
              const u0 = Math.max(0, T - 0.4 * (1 - i / N)), u1 = Math.max(0, T - 0.4 * (1 - (i + 1) / N));
              const a0 = (i / N) ** 2, a1 = ((i + 1) / N) ** 2;
              lines.push(...at(u0), r, g, b, a0 * 0.9, 1, ...at(u1), r, g, b, a1 * 0.9, 1);
            }
            heads.push(...at(T), 1, 0.95, 0.85, 1, 11 * px);
            heads.push(...at(T), r, g, b, 0.5, 26 * px);   // glow around the head
          } else {
            const f = Math.min(1, T - 1);
            flashes.push(...end, r, g, b, (1 - f) * 0.9, (8 + 60 * f) * px);
            heads.push(...end, 1, 0.95, 0.85, (1 - f), (14 - 8 * f) * px);
          }
        }
        drawDyn(lines, 2, gl.LINES, rot, p);
        drawDyn(heads, 0, gl.POINTS, rot, p);
        drawDyn(flashes, 1, gl.POINTS, rot, p);
      }
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.disable(gl.BLEND);
      clearAttribs();   // the regular passes enable only what they use
    }

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
      gl.uniform1f(Q.uRegOn, regOn && radarA > 0 ? 1 : 0);
      gl.uniform4f(Q.uRegBox, regBox[0], regBox[1], regBox[2], regBox[3]);
      gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, regTexs[radarCur] || regTexs[0]);
      gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, regTexs[radarNext] || regTexs[0]);
      gl.uniform1f(Q.uDetOn, detOn && radarA > 0 && detLayout ? 1 : 0);
      gl.uniform1fv(Q.uDetHasA, hasVec(detHas[radarCur]));
      gl.uniform1fv(Q.uDetHasB, hasVec(detHas[radarNext]));
      gl.uniform4fv(Q.uDetBox, detBoxes);
      gl.uniform4fv(Q.uDetRect, detRects);
      gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, detTexs[radarCur] || detTexs[0]);
      gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, detTexs[radarNext] || detTexs[0]);
      gl.uniform3f(Q.uEye, p.eye[0], p.eye[1], p.eye[2]);
      gl.uniform3f(Q.uCtr, p.ctr[0], p.ctr[1], p.ctr[2]);
      gl.uniform1f(Q.uRw, p.Rw);
      gl.uniform1f(Q.uR, p.R);
      gl.uniformMatrix3fv(Q.uRot, false, rot);
      gl.uniform3f(Q.uSun, p.sun[0], p.sun[1], p.sun[2]);
      gl.uniform2f(Q.uStarOff, p.starX, p.starY);
      gl.uniform1f(Q.uPx, p.px);
      if (fxTex) gl.uniform4f(Q.uFx, fx.on.lights ? 1 : 0, fx.on.aurora ? 1 : 0, fx.on.glint ? 1 : 0, ((performance.now() - fx.t0) / 1000) % 10000);
      if (fxTex) { gl.activeTexture(gl.TEXTURE8); gl.bindTexture(gl.TEXTURE_2D, lightsTex); gl.activeTexture(gl.TEXTURE9); gl.bindTexture(gl.TEXTURE_2D, aurTex); }
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
      const wx = radarA > 0 || statesOn;
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
      if (fxProgs) renderFx(rot, p);
    }

    return { setWorld, setStates, setStars, setRadar, setRadarFrames, setRadarPos, setStatesOn: (on) => { statesOn = !!on; }, render, resize, fx: FX ? fxApi : null, info: { renderer, maxTex, deriv: ext.deriv, lod: ext.lod, aniso: !!ext.aniso } };
  };
})();
