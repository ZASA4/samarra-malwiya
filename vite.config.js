import { defineConfig } from 'vite';

// base is the URL prefix every asset (JS, CSS, textures) is requested from.
// On GitHub Pages the site lives at zasa4.github.io/samarra-malwiya/ — NOT the
// domain root — so assets must be requested from /samarra-malwiya/... . Without
// this, the build would ask for /assets/... at the domain root and 404.
export default defineConfig({
  base: '/samarra-malwiya/',
});
