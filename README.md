# CT Head Helper (PWA)

An installable web app version of the "CT Scan of Head Helper" GPT. Load a head CT (DICOM series or PNG/JPG slices), review it in the built-in viewer, and get a structured AI interpretation from Claude:

```
🧠 AI Interpretation:
- Hemorrhage: Detected / Not Detected
- Infarct: Acute / Chronic / Absent
- Edema / Midline Shift: Present / Absent
- Mass Lesion: Suggestive / Absent
- Ventricular System: Normal / Hydrocephalus

🩺 Impression: ...
```

Decision support only. This is not a medical device.

## How it works

1. **Load**: drag and drop files or a whole series folder, or use Choose files, Choose folder or Take photo (phone camera). DICOM is parsed in the browser (`js/dicom.js`): Implicit and Explicit VR Little Endian, multi-frame and MONOCHROME1 are supported. Compressed DICOM (JPEG/JPEG-LS/J2K/RLE) is reported as unsupported; export it uncompressed or as PNG.
2. **Preprocess** (`js/imaging.js`): series are grouped by SeriesInstanceUID and sorted along the slice normal. Pixels are rescaled to HU and windowed (brain W80/L40, subdural W215/L75, bone W2800/L600). Each slice is fitted to a 256 px tile and packed into 4×4 montages labelled `#N`. Every slice of every series is sent, up to the per-series limit in Settings (192 by default). Longer series are evenly sampled across the whole head.
3. **Interpret** (`js/ai.js`): the montages go to Claude (Opus 5.5 by default, Sonnet 5.5 optional) with adaptive thinking at high effort. Structured outputs return the report as JSON, with server-side refusal fallback enabled. Follow-up questions reuse the cached images.
4. **Simulated CNN comparison** (optional): an illustrative per-architecture view (ResNet-50, DenseNet-121, EfficientNet-B0, InceptionV3). It is clearly labelled as simulated: no CNN actually runs. The `j00jun/Brain-CT-Classification` repo the GPT referenced returns 404, so its exact class list could not be reproduced.

Privacy: patient identifier tags are never read from DICOM files, and only the rendered pixel montages are sent. The API key and up to 25 past reports (text only) are stored in this browser's localStorage.

## Run locally

```bash
python -m http.server 8765 --directory "C:/Users/User/Desktop/Claude AI/CT Head Helper"
```

Then open http://localhost:8765, open Settings and paste an Anthropic API key. A synthetic test series (a geometric phantom with a crescentic hyperdensity, no patient data) is in `samples/synthetic-phantom/`.

## Install on a phone

PWAs install only over HTTPS. Host this folder on any static host (GitHub Pages, Netlify, Cloudflare Pages, Render static site), open it in Chrome or Safari, then use Install app or Add to Home Screen. The viewer works offline once loaded; interpretation needs a connection.

## Files

| Path | Purpose |
|---|---|
| `index.html`, `css/styles.css` | UI shell (light/dark, phone-friendly) |
| `js/app.js` | UI logic, payload building, report rendering, history |
| `js/dicom.js` | Minimal DICOM reader |
| `js/imaging.js` | Series grouping, HU windowing, montages |
| `js/ai.js` | Claude API calls, system prompt, report schema |
| `sw.js`, `manifest.webmanifest`, `icons/` | PWA install + offline shell |
| `tools/make_assets.py` | Regenerates PNG icons and the synthetic phantom |

Bump `VERSION` in `sw.js` when you change shell files, so installed copies refresh.
