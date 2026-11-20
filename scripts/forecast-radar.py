# Part of TERoomApp - created by Christopher Hunt (github.com/lucidium2000).
"""Forecast weather radar for the globe's radar button (Radar: forecast).

NOAA's GFS model (global, 0.25 deg, public domain, no key) forecasts the
radar reflectivity it expects (REFC, "composite reflectivity"). This picks the
latest model run on NOAA's AWS open-data bucket, fetches just that field for
each hour from now to HOURS ahead (about 1 MB each, by byte range from the
.idx), colours it like NEXRAD radar and writes equirectangular PNGs
(longitude -180..180, latitude 90..-90), plus forecast.json listing them.

    python scripts/forecast-radar.py OUT_DIR

Needs: eccodes numpy pillow (pip).
"""
import datetime as dt
import json
import os
import sys
import urllib.request

import eccodes
import numpy as np
from PIL import Image

OUT = sys.argv[1] if len(sys.argv) > 1 else 'forecast'
HOURS = int(os.environ.get('FC_HOURS', '6'))     # frames: now, +1h ... +HOURS
W = int(os.environ.get('FC_W', '2048'))         # output width (height W/2; powers of two, for mipmaps); GFS itself is 1440 wide
BUCKET = 'https://noaa-gfs-bdp-pds.s3.amazonaws.com'

# NEXRAD Level III colours by dBZ (the radar's own palette, as RainViewer's scheme 6).
PAL = [(5, (4, 233, 231)), (10, (1, 159, 244)), (15, (3, 0, 244)), (20, (2, 253, 2)), (25, (1, 197, 1)),
       (30, (0, 142, 0)), (35, (253, 248, 2)), (40, (229, 188, 0)), (45, (253, 149, 0)), (50, (253, 0, 0)),
       (55, (212, 0, 0)), (60, (188, 0, 0)), (65, (248, 0, 253)), (70, (152, 84, 198))]
MIN_DBZ = 17   # below this the model's reflectivity is mostly drizzle and noise: leave clear


def get(url, rng=None, timeout=60):
    req = urllib.request.Request(url, headers={'User-Agent': 'TERoomApp forecast radar'})
    if rng:
        req.add_header('Range', 'bytes=%d-%s' % rng)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def run_files(run, fh):
    base = '%s/gfs.%s/%02d/atmos/gfs.t%02dz.pgrb2.0p25.f%03d' % (BUCKET, run.strftime('%Y%m%d'), run.hour, run.hour, fh)
    return base, base + '.idx'


def refc_range(idx_text):
    lines = idx_text.splitlines()
    for i, ln in enumerate(lines):
        if ':REFC:entire atmosphere:' in ln:
            start = int(ln.split(':')[1])
            end = str(int(lines[i + 1].split(':')[1]) - 1) if i + 1 < len(lines) else ''
            return start, end
    return None


def latest_run(now, need_fh):
    """The newest run whose forecast hours up to need_fh are all published."""
    t = now.replace(minute=0, second=0, microsecond=0)
    t -= dt.timedelta(hours=t.hour % 6)
    for _ in range(8):
        last = int((now - t).total_seconds() // 3600) + need_fh
        try:
            get(run_files(t, last)[1], timeout=20)
            return t
        except Exception:
            t -= dt.timedelta(hours=6)
    raise SystemExit('no complete GFS run found')


def colour(dbz):
    """dBZ grid -> a palette image: NEXRAD colours, clear below MIN_DBZ.
    (Hard edges here keep the file small; the browser softens them.)"""
    levels = np.array([p[0] for p in PAL], float)
    k = np.clip(np.searchsorted(levels, dbz, side='right') - 1, 0, len(PAL) - 1) + 1
    k[dbz < MIN_DBZ] = 0
    im = Image.fromarray(k.astype(np.uint8), 'P')
    im.putpalette([0, 0, 0] + [c for _, rgb in PAL for c in rgb])
    im.info['transparency'] = bytes([0] + [235] * len(PAL))
    return im


def frame(run, fh):
    url, idx = run_files(run, fh)
    rng = refc_range(get(idx).decode())
    if not rng:
        raise RuntimeError('no REFC in f%03d' % fh)
    msg = eccodes.codes_new_from_message(get(url, rng))
    try:
        ni, nj = eccodes.codes_get(msg, 'Ni'), eccodes.codes_get(msg, 'Nj')
        vals = eccodes.codes_get_values(msg).reshape(nj, ni)    # lat 90..-90, lon 0..359.75
        miss = eccodes.codes_get(msg, 'missingValue')
    finally:
        eccodes.codes_release(msg)
    vals = np.where(vals == miss, -20, vals)
    vals = np.roll(vals, ni // 2, axis=1)[:nj - 1]               # lon -180..179.75, drop the -90 row
    # Smooth upsampling of the values themselves, so storms get soft round edges, not 25 km squares.
    im = Image.fromarray(vals.astype(np.float32), 'F').resize((W, W // 2), Image.BICUBIC)
    return colour(np.asarray(im))


def main():
    now = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
    start = now.replace(minute=0, second=0, microsecond=0)
    run = latest_run(now, HOURS + 1)
    os.makedirs(OUT, exist_ok=True)
    keep, frames = set(['forecast.json']), []
    for h in range(HOURS + 1):
        valid = start + dt.timedelta(hours=h)
        fh = int((valid - run).total_seconds() // 3600)
        name = 'r%s_f%03d.png' % (run.strftime('%Y%m%d%H'), fh)
        path = os.path.join(OUT, name)
        if not os.path.exists(path):
            frame(run, fh).save(path, optimize=True)
        keep.add(name)
        frames.append({'t': int(valid.replace(tzinfo=dt.timezone.utc).timestamp() * 1000), 'f': name})
        print('frame', valid.isoformat() + 'Z', 'from run', run.isoformat() + 'Z', 'f%03d' % fh, os.path.getsize(path), 'bytes')
    for f in os.listdir(OUT):   # drop frames from older runs or hours now past
        if f.endswith('.png') and f not in keep:
            os.remove(os.path.join(OUT, f))
    with open(os.path.join(OUT, 'forecast.json'), 'w') as fp:
        json.dump({'run': int(run.replace(tzinfo=dt.timezone.utc).timestamp() * 1000), 'src': 'NOAA GFS', 'w': W, 'frames': frames}, fp)


if __name__ == '__main__':
    main()
