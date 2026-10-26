# Hello! globe

A standalone Quick site: a draggable 3D Earth lit by the real sun right now, centered on the viewer.

- `site/` is the folder to publish. One `index.html` (three.js bundled inline, so no `.js` MIME guessing on upload) plus three textures. About 2.6 MB, 4 files.
- `src/` rebuilds it: `npm i three@0.170.0 esbuild@0.24.0`, put the textures in `../site/textures`, then `bash build.sh`.

Publish: `quick deploy hello ./site`

Features: real-time day/night terminator from the solar ephemeris, city lights on the night side, sun glint on water, atmosphere glow,
drag to spin and scroll/pinch to zoom, browser geolocation with a time-zone fallback, a "you are here" marker, sun altitude readout,
and a fast-forward button (one hour per second). Respects prefers-reduced-motion.

Credits and licences: NASA Blue Marble and Black Marble imagery (public domain, via the three-globe example images),
three.js (MIT). Fonts load from Google Fonts (Unbounded, JetBrains Mono; OFL).
