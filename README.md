# Internet Outage Globe

A full-screen, touch-friendly globe of live Internet outages from **ThousandEyes Internet Insights** (the public feed behind [thousandeyes.com/outages](https://www.thousandeyes.com/outages/)), built for **Cisco RoomOS** devices: Desk Pro, Board, and Room Navigator. The globe styling follows [TE-Optics](https://github.com/lucidium2000/TE-Optics).

- **Globe:** shaded ocean, navy land, live day/night terminator, panning starfield, atmosphere glow.
- **Network outages** (ISPs, clouds, CDNs) are shown in TE orange. **Application outages** (SaaS) are shown in TE cyan. Active outages pulse.
- **Tap an outage** on the globe or in the list. The globe flies there, links the affected locations with great-circle arcs and labels the cities.
- **Tour mode** runs from launch. Touch stops it, and it resumes after 30 s idle. It cycles through active and recent outages, which suits a lobby screen or a device sitting idle between meetings.
- **"Your services"** shows at a glance whether Webex, Zoom, Microsoft 365, Google or AWS had outages, so people can tell "is it me or the internet?"
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
- **Expect some lag.** Detection runs at about 15 Hz on the CPU and is smoothed, so the parallax trails your movement slightly.

## URL options

| Param | Default | |
|---|---|---|
| `tour` | on | tours from launch and resumes after `idle`; `0` disables it |
| `idle` | `30` | seconds without touch before the tour starts |
| `dwell` | `10` | seconds per outage on tour |
| `spin` | `3` | idle rotation, degrees/second |
| `watch` | `webex,zoom,microsoft,google,amazon` | services for the "Your services" strip; also `teams`, `slack`, `salesforce`, `cloudflare`, `github`, or any keyword |
| `refresh` | `300` | data reload, seconds |
| `detail` | `110m` | `50m` for sharper coastlines (heavier on the device) |
| `dpr` | `1.5` | render pixel-ratio cap; lower it if a device struggles |
| `glass` | off | `1` starts Glass mode on load (the device must allow camera access) |
| `signage` | off | `1` for non-interactive signage |
| `kiosk` | off | `1` hides the cursor |
| `data` | auto | override the outages.json URL |

## Local development

```bash
node scripts/fetch-outages.mjs      # refresh data/outages.json
python3 -m http.server 8765         # then open http://localhost:8765
```

No build step and no dependencies. d3-geo, topojson-client and the Natural Earth world atlas are bundled in `vendor/`.
