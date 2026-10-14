# Internet Outage Globe

A full-screen, touch-friendly globe of live Internet outages from **ThousandEyes Internet Insights** (the public feed behind [thousandeyes.com/outages](https://www.thousandeyes.com/outages/)), built for **Cisco RoomOS** devices: Desk Pro, Board, and Room Navigator. The globe styling follows [TE-Optics](https://github.com/lucidium2000/TE-Optics).

- **Globe:** shaded ocean, navy land, live day/night terminator, panning starfield, atmosphere glow.
- **Network outages** (ISPs, clouds, CDNs) are shown in TE orange. **Application outages** (SaaS) are shown in TE cyan. Active outages pulse.
- **Tap an outage** on the globe or in the list. The globe flies there, links the affected locations with great-circle arcs and labels the cities.
- **Tour mode** runs from launch. Touch stops it, and it resumes after 10 s idle (HUD or Free mode). It cycles through active and recent outages, which suits a lobby screen or a device sitting idle between meetings.
- **"Your services"** shows at a glance whether Webex, Zoom, Microsoft 365, Google or AWS had outages, so people can tell "is it me or the internet?"
- **HUD / Free modes:** the frame button on the left switches modes, and the device remembers the choice. HUD shows the side panel, the outage card and the timeline. Free mode is a clean globe: the panels are hidden, the controls fade away until someone touches the screen, and when the globe zooms into an outage a small floating window appears next to the affected locations.
- **24-hour timeline** of outage starts. New outages that arrive on a refresh get a toast and a fly-to.

> Unofficial community project, not affiliated with or endorsed by Cisco/ThousandEyes. The data endpoint is the one the public outage map uses. It isn't a documented API and may change.

## How it works

```
ThousandEyes public outage feed ──(no CORS)──✗ browser on device
          │
   GitHub Action (every ~5 min)  scripts/fetch-outages.mjs
          │  force-pushes outages.json to the `data` branch
          ▼
raw.githubusercontent.com/<you>/<repo>/data/outages.json  (CORS: *)
          │
   GitHub Pages  ──►  index.html on the RoomOS device
```

A browser can't call the ThousandEyes feed directly because it sends no CORS headers. A scheduled Action fetches it instead, and the page reads the result. `data/outages.json` in `main` is a snapshot fallback, so the page always shows something.

## Setup

1. Push this folder to a GitHub repo.
2. **Settings → Pages:** deploy from branch `main`, folder `/ (root)`.
3. **Settings → Actions → General → Workflow permissions:** select *Read and write*.
4. **Actions → Refresh outage data → Run workflow** once, to create the `data` branch. After that it runs on its schedule.
5. Open `https://<you>.github.io/<repo>/`. The page works out the data URL from the Pages address.

GitHub's cron is best-effort, so expect a refresh every 5–15 minutes. GitHub pauses scheduled workflows after 60 days without repo activity. Re-enable it from the Actions tab if that happens.

## Put it on a RoomOS device

Enable the web engine first (device web UI → Settings, or xAPI):

```
xConfiguration WebEngine Mode: On
```

**As a button on the device (interactive):** in the device's UI Extensions Editor, or from Control Hub, add a **Web App** with the Pages URL. To open it ad hoc from a macro or xAPI:

```
xCommand UserInterface WebView Display Url: "https://<you>.github.io/<repo>/" Title: "Internet Outages"
```

**As digital signage (when the device is idle):** use `signage=1`. The tour runs continuously and the controls are hidden.

```
xConfiguration Standby Signage Mode: On
xConfiguration Standby Signage Url: "https://<you>.github.io/<repo>/?signage=1"
```

## Glass mode (experimental)

The camera button on the left turns on head-tracked parallax. The device camera finds the person in front of the screen. It looks for a face with MediaPipe BlazeFace and falls back to tracking movement if the face model can't load. The starfield and globe then shift the opposite way while the panels stay put, so the screen feels like a pane of glass with the Earth behind it. Leaning in zooms slightly.

- **Off by default.** It starts only when someone taps the button, or with `?glass=1`. A **CAMERA** chip is shown whenever the camera is on.
- **On-device only.** Frames are analysed in the page and discarded. Nothing is uploaded. The model and runtime are served from this repo (`vendor/mediapipe`, about 9.5 MB, loaded only when Glass mode is turned on).
- **Releases the camera** when turned off, when the page is hidden, or when another app (such as a call) takes the camera.
- **The device must allow web apps to use the camera.** Turn this on in the device's WebEngine settings before trying it. Without permission, the button shows an explanation and nothing else changes.
- **Real window parallax.** With WebGL, the globe is drawn by a true off-axis perspective camera. The screen is the glass, your tracked head is the eye, and the Earth sits behind the glass at a set depth. Moving your head shows you around the side of the planet, and the stars, being "at infinity", move the most. Tune it with `depth=`, `eye=` and `eyerange=`.
- **Air swipe (experimental).** MediaPipe Hand Landmarker tracks your palms. A quick sideways sweep of the hand (more than about a fifth of the frame, faster than about one frame-width per second, mostly horizontal) spins the globe three full turns in that direction, coasting to a stop exactly where it started. A tour in progress waits for the spin to finish. Bringing your hand back after a swipe doesn't count as a swipe the other way. **Press and hold the camera button** (or use `camdebug=1`) for a camera debug view. It shows the tracked face, each hand's 21-point skeleton, swipe trails, the hand-tracking rate, and live travel and speed against the swipe thresholds, with the reason a movement didn't count (too short, too slow, too vertical, or a return stroke). Turn it off with `swipe=0`.
- **Where detection runs.** Detection starts in a background worker. With `minworkerhz=6` it checks the measured hand-tracking rate six seconds in, and below that rate moves detection to the main thread. That check is off by default: the lite model on the main thread locked up a Desk Pro. A worker's "GPU" can be a software emulation: on a Desk Pro it reported GPU and ran at about 1 frame per second. The debug view marks an automatic switch with `*` after the path. `glassworker=1` forces the worker, `glassworker=0` goes straight to the main thread, and `minworkerhz=` changes the threshold.
- **Sharing the GPU.** While the camera is on, the globe renders at 30 fps, and face detection runs on every 4th frame (`faceevery=`), leaving more of the GPU to the hand model.
- **Hand model.** On the main-thread path (the one a Desk Pro uses), hands are tracked by TF.js MediaPipe Hands **lite**. It runs on WebGL1, its models are about half the size, and it runs asynchronously, so most of its time is GPU work in the background. `hands=mediapipe` switches back to the MediaPipe Tasks full model for comparison, and `handbudget=` (0.1 to 1, default 0.6) sets how hard the lite model is driven.
- **Two swipe detectors.** Alongside the hand model, a cheap motion-sweep detector runs at about 16 Hz. It only acts when someone's face is in view and the hand model is missing or running below 8 frames per second.
- **Steady by design.** Small head movements are ignored, and tracking is smoothed and filtered, so the globe doesn't jitter.
- **Gesture guide.** While gestures are paused, a "Tap here for Gesture Info" line under the badge opens a quick guide to every gesture.
- **Palm to start, and the gesture HUD.** A small hand badge at the top center shows the gesture state. It's grey with "Lift palm to activate" while gestures are paused. Hold one open hand up, palm to the camera, for half a second: the ring fills and the badge turns green with **Ready**. While you grab, it reads **Drag**, or **Zoom ×1.6** with two fists, and goes back to Ready when you let go. Gestures pause quietly (the badge turns grey again) after half a second with no hands in view. Swipes work either way.
- **Pinch to browse (experimental).** While gestures are Ready, pinch your right index finger to your thumb to go to the next outage in the list, and your left to go back. It fires once per pinch; open your fingers before the next one. The badge flashes a pinching hand with **Next** or **Previous**. If left and right come out reversed on your device, add `pinchswap=1`.
- **Fist grab.** Close one hand into a fist and hold it still for a quarter of a second to grab the globe, then drag it around. A fist that's moving while it closes doesn't grab. It lets go after a quarter of a second of open hand, or three quarters of a second with no hand in view; open it to let go and it keeps spinning with your hand's momentum. With both hands in fists, pull them apart to zoom in, push them together to zoom out, and move them together to turn the globe. `grabpan=` sets how far the globe turns per hand movement (default `1.6`). Hand movement faster than a deliberate drag or pull (tracking glitches, someone walking past) is ignored, and the fling on release is capped. Swipes are ignored while you grab and for a moment after. Head tracking only moves the view by direction. Lean-to-zoom is off by default and can be turned back on with `leanzoom=0.85`.
- **Performance.** Detection runs in a Web Worker, on the GPU where available, so it never blocks rendering. It processes one frame at a time at up to about 20 Hz and is smoothed, so the parallax trails your movement slightly. If the worker can't start, detection runs on the main thread, limited to about 30% of the frame budget.

## URL options

| Param | Default | |
|---|---|---|
| `tour` | on | tours from launch and resumes after `idle`; `0` disables it |
| `idle` | `10` | seconds without touch before the tour starts |
| `dwell` | `10` | seconds per outage on tour |
| `spin` | `3` | idle rotation, degrees/second |
| `watch` | `webex,zoom,microsoft,google,amazon` | services for the "Your services" strip; also `teams`, `slack`, `salesforce`, `cloudflare`, `github`, or any keyword |
| `refresh` | `300` | data reload, seconds |
| `detail` | `110m` | `50m` for sharper coastlines (heavier on the device) |
| `dpr` | `1.5` | render pixel-ratio cap; lower it if a device struggles |
| `glass` | off | `1` starts Glass mode on load (the device must allow camera access) |
| `zoom` | `1.2` | resting zoom level |
| `grabpan` | `1.6` | how far a fist grab turns the globe per unit of hand travel |
| `pinchswap` | off | `1` swaps which hand goes forward and back for the pinch gesture |
| `swipe` | on | `0` disables the Glass mode air swipe |
| `hands` | `mediapipe` | hand model: `mediapipe`; `webgpu` (TF.js lite on WebGPU in the worker: asynchronous, can't block the page); or `lite` (TF.js on main-thread WebGL, experimental: locked up a Desk Pro) |
| `handbudget` | `0.6` | how hard the lite hand model is driven (`1` = back to back) |
| `camdebug` | off | `1` shows a camera preview with tracking overlays (Glass mode) |
| `depth` | `0.6` | how far behind the screen the globe sits, in screen widths; deeper means stronger parallax |
| `eye` | `1.0` | assumed viewing distance, in screen widths |
| `eyerange` | `1.2` | how far the virtual eye moves for a given head movement |
| `mode` | `hud` | `free` for the clean-globe mode |
| `leanzoom` | `0` | Glass mode lean-to-zoom strength (off; zoom is two-fist grab); `0.85` turns it on |
| `glassdelegate` | auto | `cpu` forces CPU face detection if the GPU path misbehaves |
| `maxfps` | `60` | `30` locks rendering at 30 fps (it already drops to 30 on its own if frames run long) |
| `renderer` | auto | `2d` forces the Canvas 2D renderer (WebGL is used when available) |
| `scale` | auto | fix the render resolution (`0.4`–`1`); by default it drops automatically if the device can't hold ~25 fps |
| `tex` | `8192` | WebGL land-fill texture width (coastlines and borders are vector lines regardless); `4096` saves GPU memory |
| `faceevery` | `4` | with hands on, run face detection on every Nth frame |
| `perf` | off | `1` shows frame timing and Glass tracking stats |
| `signage` | off | `1` for non-interactive signage |
| `kiosk` | off | `1` hides the cursor |
| `data` | auto | override the outages.json URL |

## Local development

```bash
node scripts/fetch-outages.mjs      # refresh data/outages.json
python3 -m http.server 8765         # then open http://localhost:8765
```

No build step and no dependencies. d3-geo, topojson-client and the Natural Earth world atlas are bundled in `vendor/`.
