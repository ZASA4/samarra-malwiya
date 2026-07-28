/**
 * LoadingOverlay — a tiny, dependency-free progress screen shown while the
 * minaret geometry downloads. It reads REAL bytes from MinaretModel's progress
 * callback (not a fake timer), fills a bar 0..100%, then fades out.
 *
 * Kept deliberately simple: one root element, all styles inline, no CSS file.
 */
export default class LoadingOverlay {
  /** @param {HTMLElement} container - element to overlay (the app div). */
  constructor(container) {
    // Full-screen dim panel, warm dusk tone to match the scene.
    this.root = document.createElement('div');
    Object.assign(this.root.style, {
      position: 'absolute',
      inset: '0',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '14px',
      background: '#1a1206',
      color: '#dccaa4',
      font: '14px/1.5 system-ui, sans-serif',
      letterSpacing: '0.08em',
      zIndex: '10',
      transition: 'opacity 0.6s ease',
    });

    this.label = document.createElement('div');
    this.label.textContent = 'LOADING THE MINARET OF SAMARRA';
    this.label.style.textTransform = 'uppercase';

    // Track + fill for the progress bar.
    const track = document.createElement('div');
    Object.assign(track.style, {
      width: 'min(320px, 60vw)',
      height: '4px',
      background: 'rgba(220, 202, 164, 0.18)',
      borderRadius: '2px',
      overflow: 'hidden',
    });
    this.fill = document.createElement('div');
    Object.assign(this.fill.style, {
      width: '0%',
      height: '100%',
      background: '#e8c98a',
      transition: 'width 0.15s linear',
    });
    track.appendChild(this.fill);

    this.detail = document.createElement('div');
    Object.assign(this.detail.style, { fontSize: '12px', opacity: '0.7' });
    this.detail.textContent = '0%';

    this.root.append(this.label, track, this.detail);
    container.appendChild(this.root);
  }

  /**
   * @param {number} fraction - 0..1 download progress.
   * @param {number} loaded   - bytes downloaded.
   * @param {number} total    - total bytes (may be 0 if server sent no length).
   */
  setProgress(fraction, loaded = 0, total = 0) {
    const pct = Math.round(fraction * 100);
    this.fill.style.width = `${pct}%`;
    const mb = (b) => (b / (1024 * 1024)).toFixed(1);
    this.detail.textContent = total ? `${pct}%  ·  ${mb(loaded)} / ${mb(total)} MB` : `${pct}%`;
  }

  /** Fade out and remove from the DOM. */
  hide() {
    this.root.style.opacity = '0';
    setTimeout(() => this.root.remove(), 650);
  }

  /** Show an error state instead of silently disappearing. */
  fail(message) {
    this.label.textContent = 'FAILED TO LOAD MODEL';
    this.detail.textContent = message;
    this.fill.style.background = '#c0563a';
  }
}
