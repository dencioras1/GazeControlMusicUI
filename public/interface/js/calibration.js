/**
 * calibration.js — teaches WebGazer where you are looking.
 *
 * WebGazer learns from mouse clicks: when you click somewhere, it assumes you
 * were looking at that spot and stores what your eyes looked like. Calibration
 * shows 9 dots spread over the screen; look at each dot and click it
 * CLICKS_PER_POINT times until it turns green.
 *
 * Learning from clicks is switched on only during calibration, so normal
 * clicks elsewhere don't disturb the model. Press Escape to cancel.
 */

const CLICKS_PER_POINT = 5;
const POSITIONS = [10, 50, 90];   // % of the screen, in both directions

/** Runs the calibration. Resolves true when completed, false when cancelled. */
export function runCalibration(wg) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'calibration';
    overlay.innerHTML = `<p class="calibration-msg">Look at each dot and click it ${CLICKS_PER_POINT} times
      until it turns green. Keep your head still. Escape cancels.</p>`;
    document.body.appendChild(overlay);
    wg.addMouseEventListeners();

    const finish = (done) => {
      wg.removeMouseEventListeners();
      window.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(done);
    };
    const onKey = (e) => { if (e.key === 'Escape') finish(false); };
    window.addEventListener('keydown', onKey);

    let remaining = POSITIONS.length ** 2;
    for (const py of POSITIONS) for (const px of POSITIONS) {
      const dot = document.createElement('div');
      dot.className = 'calibration-dot';
      dot.style.left = `${px}%`;
      dot.style.top = `${py}%`;
      let clicks = 0;
      dot.onclick = () => {
        if (clicks >= CLICKS_PER_POINT) return;
        clicks++;
        dot.style.opacity = String(1 - 0.6 * (clicks / CLICKS_PER_POINT));
        if (clicks === CLICKS_PER_POINT) {
          dot.classList.add('done');
          dot.style.opacity = '1';
          if (--remaining === 0) setTimeout(() => finish(true), 300);
        }
      };
      overlay.appendChild(dot);
    }
  });
}
