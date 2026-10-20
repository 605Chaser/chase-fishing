# Chase's Fishing Outlook

A free, installable web app (PWA) that runs on iPhone, Android and laptops from one set of files.

## Where it's hosted
GitHub Pages, from the `main` branch of this repo: https://605chaser.github.io/chase-fishing/
Every push to `main` updates the live app within a minute or two.

## Install on a device
- **iPhone (Safari):** open the link → Share → Add to Home Screen.
- **Android (Chrome):** open the link → menu → Install app.
- **Laptop (Chrome/Edge):** open the link → install icon in the address bar.

## Live data (all free, no API keys)
| What | Source |
|---|---|
| Forecast, pressure, wind, gusts, clouds, temperature | Open-Meteo (free for non-commercial use) |
| Watches and warnings | National Weather Service (api.weather.gov) |
| Water temperature | USGS Water Data APIs, falls back to legacy WaterServices (retiring Feb 2027) |
| Sunrise/sunset, moon phase, moonrise, solunar periods | SunCalc, computed on the device |
| Map and place names | OpenStreetMap tiles + Nominatim |

## How the outlook score works
Each hour starts at 50 and is adjusted for: pressure trend over 3 hours, wind speed and gusts, cloud cover,
low-light periods near sunrise and sunset, solunar major/minor periods, rain chance, and thunderstorms.
The best window is the strongest 2–4 hour stretch in the next 20 daylight hours.
Tune the weights in `scoreAt()` in `core.js` as Chase's own catch log shows what works on his water.

## Files
- `index.html` — screens and layout
- `core.js` — data fetching, sun/moon math and scoring (no UI)
- `sw.js`, `manifest.webmanifest`, `icon*` — install and offline support

Saved spots and the catch log are stored on each device (browser storage), so they don't sync between devices yet.
If the app is ever sold or used commercially, Open-Meteo requires a paid plan.
