# Internet Outage Globe

A full-screen, touch-friendly globe of live Internet outages from **ThousandEyes Internet Insights** (the public feed behind [thousandeyes.com/outages](https://www.thousandeyes.com/outages/)), built for **Cisco RoomOS** devices: Desk Pro, Board, and Room Navigator. The globe styling follows [TE-Optics](https://github.com/lucidium2000/TE-Optics).

- **Globe:** shaded ocean, navy land, live day/night terminator, panning starfield, atmosphere glow.
- **Network outages** (ISPs, clouds, CDNs) are shown in TE orange. **Application outages** (SaaS) are shown in TE cyan. Active outages pulse.
- **Tap an outage** on the globe or in the list. The globe flies there, links the affected locations with great-circle arcs and labels the cities.
- **Tour mode** runs from launch. Touch stops it, and it resumes after 10 s idle (HUD or Free mode). It cycles through active and recent outages, which suits a lobby screen or a device sitting idle between meetings.
- **"Your services"** gives one row per service. On the left is its Internet Insights status (clear, *N in 24h*, or *active outage*, which you can tap to open that outage). On the right is this room's live connection to it: response-time sparkline, latency and HTTP result. The dot shows the worse of the two, so people can tell "is it me or the internet?" at a glance. Tap a row for a path trace.
- **HUD / Free modes:** the frame button on the left switches modes, and the device remembers the choice. HUD shows the side panel, the outage card and the timeline. Free mode is a clean globe: the panels are hidden, the controls fade away until someone touches the screen, and when the globe zooms into an outage a small floating window appears next to the affected locations.
- **Weather on city labels:** when an outage is selected, each city label shows the current temperature and a weather symbol (sun, sun and cloud, cloud, fog, rain, snow or storm, with a moon at night), from [Open-Meteo](https://open-meteo.com). Shown in °F by default; `units=c` switches to Celsius.
- **24-hour timeline** of outage starts. Drag (or tap) along it to scrub: a line and label show the time, how many outages started around then and the nearest one, while the globe and bars dim everything else. While you scrub, the globe lazily drifts toward the nearest outage on a soft spring: it starts very slowly, curves smoothly toward a new target if you move on, and eases in. Letting go opens the outage nearest that time. New outages that arrive on a refresh get a toast and a fly-to.

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

## From this room

A small, in-browser take on a ThousandEyes agent. Every 30 seconds the page measures response time from this device to lightweight service endpoints rather than marketing websites: Webex's device-management health check (`wdm-a.wbx2.com`), Microsoft Graph (`graph.microsoft.com`), Zoom's static content network (`st1.zoom.us`), Google's API front end (`www.googleapis.com`) and the AWS EC2 us-east-1 health check. Hover over a row to see its address. Each service gets a warm-up request so the connection is open, then one timed request; this is HTTP response time as the browser sees it, not ping. Each service is colored against its own recent baseline, so a service that's always around 370 ms is green there and only turns amber or red when it's noticeably slower than usual, or red when it doesn't reply. Each service also shows a sparkline of recent samples and the HTTP result of the HTTPS request, such as `200 OK` or `404 Not Found`. All five endpoints allow cross-origin reads, so the real status is visible. When the same provider has an outage in the list, a red dot (amber if recent) follows the code; tap it to open that outage. It appears in the side panel in HUD mode and as a slim row of chips in Free mode. **Click a row (or chip) for a path trace:** a web page can't run traceroute itself, so the app runs an MTR (TCP 443) on [Globalping](https://globalping.io) from a public probe on the same ISP as this room. The room's ISP and approximate location come from its public IP, via ipinfo.io. If no probe is on that ISP, it uses the same city, then the same country. The card shows a ThousandEyes-style path visualization: the probe as a green square, then each hop as a node and the destination in cyan. Each link is labeled with the latency it adds, and turns amber from +15 ms and red from +30 ms (`pathhigh=` sets the red threshold). Hops with partial loss get a red ring, hops that don't reply are dashed grey, and each network (ASN) is grouped in a labeled band. The same coloring, latency labels and loss rings are drawn on the globe, where the geolocated hops run from the probe to the service. Full hop details sit underneath. This sends the room's public IP to ipinfo.io and the target hostname to Globalping. While the camera is on, the globe renders at 1x to leave GPU time for hand tracking. `roomnet=0` turns the probes off.

## Sounds

Short, soft interface sounds are synthesized in the browser (no audio files) for button taps, selecting outages (tour steps are silent), new-outage alerts, camera on/off, and each gesture: ready, grab and let go, pinch, swipe, and opening and closing the guide. Browsers only allow sound after the first touch, so an untouched signage screen stays silent. `sound=0` mutes everything and `volume=` (0–2) scales it.

## Glass mode (experimental)

The camera button on the left turns on head-tracked parallax. The device camera finds the person in front of the screen. It looks for a face with MediaPipe BlazeFace and falls back to tracking movement if the face model can't load. The starfield and globe then shift the opposite way while the panels stay put, so the screen feels like a pane of glass with the Earth behind it. Leaning in zooms slightly.

- **Off by default.** It starts only when someone taps the button, or with `?glass=1`. A **CAMERA** chip is shown whenever the camera is on.
- **On-device only.** Frames are analysed in the page and discarded. Nothing is uploaded. The model and runtime are served from this repo (`vendor/mediapipe`, about 9.5 MB, loaded only when Glass mode is turned on).
- **Releases the camera** when turned off, when the page is hidden, or when another app (such as a call) takes the camera.
- **The device must allow web apps to use the camera.** Turn this on in the device's WebEngine settings before trying it. Without permission, the button shows an explanation and nothing else changes.
- **Real window parallax.** With WebGL, the globe is drawn by a true off-axis perspective camera. The screen is the glass, your tracked head is the eye, and the Earth sits behind the glass at a set depth. Moving your head shows you around the side of the planet, and the stars, being "at infinity", move the most. It's a deliberately soft effect: your resting position becomes the center, small movements are ignored, and the view eases after your head on a smooth spring rather than snapping. Tune it with `parallax=` (strength, default `1`, `0` to turn it off), `depth=` and `eye=`.
- **Air swipe (experimental).** MediaPipe Hand Landmarker tracks your palms. A quick sideways sweep of the hand (more than about a fifth of the frame, faster than about one frame-width per second, mostly horizontal) spins the globe three full turns in that direction, coasting to a stop exactly where it started. A tour in progress waits for the spin to finish. Bringing your hand back after a swipe doesn't count as a swipe the other way. **Press and hold the camera button** (or use `camdebug=1`) for a camera debug view. It shows the tracked face, each hand's 21-point skeleton, swipe trails, the hand-tracking rate, and live travel and speed against the swipe thresholds, with the reason a movement didn't count (too short, too slow, too vertical, or a return stroke). Turn it off with `swipe=0`.
- **Where detection runs.** Detection starts in a background worker. With `minworkerhz=6` it checks the measured hand-tracking rate six seconds in, and below that rate moves detection to the main thread. That check is off by default: the lite model on the main thread locked up a Desk Pro. A worker's "GPU" can be a software emulation: on a Desk Pro it reported GPU and ran at about 1 frame per second. The debug view marks an automatic switch with `*` after the path. `glassworker=1` forces the worker, `glassworker=0` goes straight to the main thread, and `minworkerhz=` changes the threshold.
- **Sharing the GPU.** While the camera is on, the globe renders at 30 fps, and face detection runs on every 4th frame (`faceevery=`), leaving more of the GPU to the hand model.
- **Hand model.** On the main-thread path (the one a Desk Pro uses), hands are tracked by TF.js MediaPipe Hands **lite**. It runs on WebGL1, its models are about half the size, and it runs asynchronously, so most of its time is GPU work in the background. `hands=mediapipe` switches back to the MediaPipe Tasks full model for comparison, and `handbudget=` (0.1 to 1, default 0.6) sets how hard the lite model is driven.
- **Two swipe detectors.** Alongside the hand model, a cheap motion-sweep detector runs at about 16 Hz. It only acts when someone's face is in view and the hand model is missing or running below 8 frames per second.
- **Smooth by design.** Head tracking follows a soft spring toward a gently curved response, re-centers on your resting position over about 10 seconds, and glides back to center when you leave the view.
- **Hand cursor (gestures v2, default).** With the camera on, hold an open, upright palm still for about 0.6 s (the badge ring fills; `palmhold=<ms>` tunes it) to activate gestures. That puts a faint, translucent silhouette of your own hand on screen, drawn from the 21 tracked points so its fingers bend, spread and curl with yours; its brighter centre dot is the pointer, and it lights up blue over anything clickable. **Pinch (index finger to thumb, either hand) to click** under the dot, instantly. Buttons, list rows, filter chips, the timeline and globe markers all work. Both hands get a silhouette; the dot stays with one of them. **A grab is deliberate:** a tight, upright fist held still for 0.3 s (and seen closed in two hand results in a row); the fist tints blue while it arms, then turns solid blue when it has hold. Two fists zoom. `grabhold=<ms>` changes the hold, `handsize=<px>` the silhouette size (default 140), `handalpha=` its visibility (default 0.035), `handviz=0` shows only the pointer dot (no silhouettes). The palm-hold version is kept as `gestures=v1` (git tag `gestures-v1`).
- **Smooth hand tracking on slow hardware.** The hand model only returns ~6 results a second on the Desk Pro, so: landmarks go through a One Euro filter (steady when your hand is still, quick when it moves; `handcutoff`, default 0.5 Hz, and `handbeta`, default 4); every result carries its camera-capture time; and the on-screen hands glide between results at constant speed, drawn about one result behind (`handlag`, default 0.9). A pinch only clicks when seen in two results in a row with the hand nearly still. The model needs 0.5 confidence to report a hand.
- **Spoken summaries (experimental): the speaker button above the camera button.** Tap it to turn speech on (it downloads the voice model, ~90 MB once, then cached; the button blinks while loading) or off (which unloads the model). Speech and camera gestures never run together: turning one on switches the other off, since both lean on the same CPU. Press and hold the speaker button to set the speaking speed (0.8x to 1.5x) and pick a voice from all 28 English Kokoro voices (American and British, female and male; tapping one says hello in it) and to see how fast speech is being made on this device. The pick is remembered on that device. Kokoro-82M text-to-speech runs in the browser, in a background worker ([kokoro-js](https://github.com/hexgrad/kokoro), Apache-2.0; its text-to-phoneme step uses espeak-ng, which is GPL - fine for a demo, worth checking before shipping anything commercial). It speaks an outage's summary when one is selected (tour or tap), new-outage alerts, and path trace results; selecting something else or closing cuts it off. The library loads from jsDelivr and the model and voices from Hugging Face, cached by the browser after the first load. Speed: on a Mac with WebGPU it generates 6-9x faster than real time; on the CPU (single-threaded - GitHub Pages can't enable the cross-origin isolation that multi-threading needs) about 1.5x *slower* than real time on a Mac, and expect several times slower on the Desk Pro, whose browser offers no WebGPU adapter. Speech stays on across the app's self-update reloads. What it says is kept short and conversational - the way someone would mention it in passing, not a readout: the tour doesn't go outage by outage - it gives one overall synopsis, under a paragraph (how healthy the internet is right now, which services have had the worst of it, and whether this room is affected), when it starts, when speech is turned on, and again as it loops round (at most every 10 minutes), and the tour steps themselves are silent, and once the synopsis starts it always finishes (tour steps, tapping or closing an outage, or a heads-up don't cut it off - only turning speech off does); tapping an outage says a line or two about that one; new outages get a one-line heads-up; path traces get one or two sentences. Names are said the way people say them ("Office three six five", no "Inc."). The speaker button glows while speech is being made and its waves pulse while talking; errors show up as a message.
- **Globe physics.** The globe carries real momentum. A fist (or finger) drag holds it like a hand on a desk globe: grabbing a spinning globe catches it, and letting go leaves it spinning at the speed your hand was moving, coasting for several seconds to a stop. It spins freely about its axis, while tilt settles quickly. A drag that was barely moving when you let go just stops - no unintended drift (`flingmin`, px/s, default 250). `grabhz` sets how tightly a fist holds it (default 4) and `grablead` how far ahead of the hand it aims (ms, default 50).
- **Gesture guide.** A short guide opens as soon as the camera (gestures) turns on: hold up an open palm to start, pinch to click, fist to grab and turn, two fists to zoom, swipe to spin. Holding up an open palm closes it and starts gestures; the X closes it too. While gestures are paused, "Tap here for Gesture Info" under the badge opens it again. (`gestures=v1` shows the old scheme's guide.)
- **Palm to start, and the gesture HUD.** A small hand badge at the top center shows the gesture state. It's grey with "Lift palm to activate" while gestures are paused. Hold one open hand up, palm to the camera, for half a second: the ring fills and the badge turns green with **Ready**. While you grab, it reads **Drag**, or **Zoom ×1.6** with two fists, and goes back to Ready when you let go. Gestures pause quietly (the badge turns grey again) after half a second with no hands in view. Swipes work either way.
- **Pinch to browse (experimental).** While gestures are Ready, pinch your right index finger to your thumb to go to the next outage in the list, and your left to go back. It fires once per pinch; open your fingers before the next one. The badge flashes a pinching hand with **Next** or **Previous**. If left and right come out reversed on your device, add `pinchswap=1`.
- **Fist grab.** Close one hand into a fist and hold it still for a quarter of a second to grab the globe, then drag it around. A fist that's moving while it closes doesn't grab. It lets go after a quarter of a second of open hand, or three quarters of a second with no hand in view; open it to let go and it keeps spinning with your hand's momentum. With both hands in fists, pull them apart to zoom in, push them together to zoom out, and move them together to turn the globe. `grabpan=` sets how far the globe turns per hand movement (default `1.6`). Hand movement faster than a deliberate drag or pull (tracking glitches, someone walking past) is ignored, and the fling on release is capped. Swipes are ignored while you grab and for a moment after. Head tracking only moves the view by direction. Lean-to-zoom is off by default and can be turned back on with `leanzoom=0.85`.
- **Performance.** Detection runs in a Web Worker, on the GPU where available, so it never blocks rendering. It processes one frame at a time at up to about 20 Hz and is smoothed, so the parallax trails your movement slightly. If the worker can't start, detection runs on the main thread, limited to about 30% of the frame budget.

## Device Lab

The camera debug view (hold the camera button, or `camdebug=1`) comes with a Device Lab panel that shows what a web page can actually use on the device:

- **Room (live):** number of people (faces) in view, estimated distance to each (from face size and an assumed camera field of view; `hfov=` sets it, default 71°), the nearest person's position, light level, contrast and motion.
- **Sound (opt-in):** after tapping *Enable mic*, live level, peak, 15-second noise floor, voice activity and dominant pitch, plus the mic's settings.
- **Camera:** the resolution and frame rate it delivers and its maximum; whether pan, tilt or zoom are controllable (with *Zoom +/-* buttons if so); exposure, focus and white-balance controls; all cameras, mics and speakers the page can see.
- **Network:** the browser's own connection estimate and a measured round-trip test to the data source, the app host, thousandeyes.com and webex.com.
- **Device:** RoomOS and Chrome versions, CPU cores, memory, screen, touch points, WebGL, WebGPU adapter details, WebNN, speech recognition, wake lock, storage and permission states.

The only network traffic it creates is the round-trip test, and the microphone only starts when you tap the button.

## Updates

The page checks for a new published version about once a minute. When it finds one, it waits until the screen has been left alone for 20 seconds, shows "Updating…" and reloads. If the camera was on, it comes back on. To reload right away, press and hold the ThousandEyes logo for a second. `autoupdate=0` turns automatic updates off.

## URL options

| Param | Default | |
|---|---|---|
| `tour` | on | tours from launch and resumes after `idle`; `0` disables it |
| `idle` | `20` | seconds without touch before the tour starts |
| `dwell` | `10` | seconds per outage on tour |
| `spin` | `3` | idle rotation, degrees/second |
| `watch` | `webex,zoom,microsoft,google,amazon` | services for the "Your services" strip; also `teams`, `slack`, `salesforce`, `cloudflare`, `github`, or any keyword |
| `refresh` | `300` | data reload, seconds |
| `detail` | `110m` | `50m` for sharper coastlines (heavier on the device) |
| `dpr` | `1.5` | render pixel-ratio cap; lower it if a device struggles |
| `glass` | off | `1` starts Glass mode on load (the device must allow camera access) |
| `zoom` | `1.2` | resting zoom level |
| `grabpan` | `1.6` | how far a fist grab turns the globe per unit of hand travel |
| `gestures` | v2 | `v1` brings back the palm-hold gesture scheme and its guide (no hand cursor) |
| `tts` | on | `0` hides the speaker button (spoken summaries) |
| `ttsvoice` | af_heart | Kokoro voice, e.g. `am_michael`, `bf_emma`, `bm_george` (or hold the speaker button to pick one) |
| `ttsspeed` | 1 | speaking speed, 0.5 to 2 (or hold the speaker button to pick one) |
| `ttsdevice` | auto | `webgpu` or `wasm` (CPU); auto uses WebGPU when the browser offers it |
| `ttsdtype` | auto | model precision: `fp32` (GPU default), `q8` (CPU default), `fp16`, `q4`, `q4f16` |
| `pinchswap` | off | `1` swaps which hand goes forward and back for the pinch gesture |
| `swipe` | on | `0` disables the Glass mode air swipe |
| `hands` | `mediapipe` | hand model: `mediapipe`; `webgpu` (TF.js lite on WebGPU in the worker: asynchronous, can't block the page); or `lite` (TF.js on main-thread WebGL, experimental: locked up a Desk Pro) |
| `handbudget` | `0.6` | how hard the lite hand model is driven (`1` = back to back) |
| `camdebug` | off | `1` shows a camera preview with tracking overlays (Glass mode) |
| `depth` | `0.6` | how far behind the screen the globe sits, in screen widths; deeper means stronger parallax |
| `eye` | `1.0` | assumed viewing distance, in screen widths |
| `parallax` | `1` | strength of the head-tracked parallax; `0` turns it off |
| `mode` | `hud` | `free` for the clean-globe mode |
| `leanzoom` | `0` | Glass mode lean-to-zoom strength (off; zoom is two-fist grab); `0.85` turns it on |
| `glassdelegate` | auto | `cpu` forces CPU face detection if the GPU path misbehaves |
| `maxfps` | `60` | `30` locks rendering at 30 fps (it already drops to 30 on its own if frames run long) |
| `renderer` | auto | `2d` forces the Canvas 2D renderer (WebGL is used when available) |
| `scale` | auto | fix the render resolution (`0.4`–`1`); by default it drops automatically if the device can't hold ~25 fps |
| `tex` | `8192` | WebGL land-fill texture width (coastlines and borders are vector lines regardless); `4096` saves GPU memory |
| `faceevery` | `4` | with hands on, run face detection on every Nth frame |
| `sound` | on | `0` mutes interface sounds |
| `volume` | `1` | interface sound volume, 0–2 |
| `hfov` | `71` | camera horizontal field of view in degrees, for Device Lab distance estimates |
| `roomnet` | on | `0` turns off the room response-time probes |
| `pathhigh` | `30` | path trace: latency (ms) a link must add to turn red; amber at half |
| `units` | `f` | `c` shows weather temperatures in Celsius |
| `perf` | off | `1` shows frame timing and Glass tracking stats |
| `autoupdate` | on | `0` stops the page reloading itself when a new version is published |
| `signage` | off | `1` for non-interactive signage |
| `kiosk` | off | `1` hides the cursor |
| `data` | auto | override the outages.json URL |

## Local development

```bash
node scripts/fetch-outages.mjs      # refresh data/outages.json
python3 -m http.server 8765         # then open http://localhost:8765
```

No build step and no dependencies. d3-geo, topojson-client and the Natural Earth world atlas are bundled in `vendor/`.
