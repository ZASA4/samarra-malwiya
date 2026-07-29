# AL-MALWIYYA — Samarra, 861 CE

An interactive 3D web scene of the **Malwiya minaret** of the Great Mosque of
Samarra, capital of the Abbasid Caliphate, set at sunset. Built with
**Three.js + Vite** (vanilla JavaScript, no framework).

Live: https://zasa4.github.io/samarra-malwiya/

## Running locally

```bash
npm install
npm run dev      # start the Vite dev server
npm run build    # production build into dist/
```

## The minaret

The tower is the Sketchfab model **"The Minaret of Samarra, Iraq"** (see credit
below), used **for its FORM only**. On load the app:

- strips the model's baked PBR textures entirely and downloads only its geometry
  (~2.5 MB instead of ~9.7 MB), with a real byte-accurate progress bar;
- rescales it so the tower is exactly **52 m** tall and seats its base on the
  terrain (no floating, no sinking);
- applies our own **procedural fired-brick material** — triplanar mapping, brick
  courses, cavity dirt, edge wear, weathering and a procedural **normal-relief
  bump** (which compensates the scan's smoothing so the surface reads as fired
  brick, without altering the geometry) — evaluated in world space, so the
  surface is entirely ours, not the model's baked textures;
- **clips a scan artifact** the model shipped baked into its mesh above the
  summit, and rebuilds the crown as a procedural **open, blind-arch-niched
  pavilion** (`src/scene/SummitPavilion.js`) matching `docs/reference/`.

The original hand-built procedural minaret lives in `src/scene/Malwiya.js`; it is
kept for comparison but is no longer rendered.

## Credits

3D model: **"The Minaret of Samarra, Iraq"** by **Chenzoss** (Sketchfab).

- Model page: https://sketchfab.com/3d-models/the-minaret-of-samarra-iraq-d8ebe7c756f2414bb70768d936f2d137
- Author: https://sketchfab.com/Chenzoss
- Licence: **CC-BY-4.0** — http://creativecommons.org/licenses/by/4.0/

Attribution, as required by the licence:

> This work is based on "The Minaret of Samarra, Iraq"
> (https://sketchfab.com/3d-models/the-minaret-of-samarra-iraq-d8ebe7c756f2414bb70768d936f2d137)
> by Chenzoss (https://sketchfab.com/Chenzoss) licensed under CC-BY-4.0
> (http://creativecommons.org/licenses/by/4.0/)

**Changes made to the model:** its baked materials/textures were removed and
replaced with our own procedural fired-brick shader; the scanned tower was
rescaled (to 52 m) and re-seated on the ground; a scan artifact above the summit
was clipped and the crown was rebuilt as a procedural open, niched pavilion. CC
BY 4.0 permits these modifications and commercial use with attribution.
