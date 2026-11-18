/**
 * pie-menu.js — a round menu split into equal segments, with a hub in the middle.
 *
 * Used twice on the page: the tapper pie (which tapper is selected / playing)
 * and the beat pie (the 8-beat sequence of the selected tapper).
 *
 * Drawn as SVG in a 200 x 200 coordinate system centred on (0, 0), so it scales
 * to any size. Segment 0 starts at the top, the others follow clockwise.
 *
 * Each segment and the hub register as gaze targets. Their "contains" test is
 * plain geometry (distance from the centre + angle), which is much faster than
 * asking the browser which element is under a point.
 *
 * Visual states are CSS classes on each segment's <g> element:
 *   selected, note, playing, playhead, has-notes  (see interface.css)
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

// Geometry in SVG units (the whole pie is 200 units wide)
const OUTER_R = 96;    // outer edge of the segments
const INNER_R = 40;    // inner edge of the segments
const HUB_R = 34;      // centre circle
const GAP_DEG = 1.5;   // visual gap between segments
const LABEL_R = (OUTER_R + INNER_R) / 2;

const svgEl = (tag, attrs = {}) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

/** Point on a circle; 0 degrees = top, clockwise. */
const polar = (r, deg) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [r * Math.cos(a), r * Math.sin(a)];
};

/** SVG path of one ring segment between two angles. */
function segmentPath(startDeg, endDeg) {
  const [x1, y1] = polar(OUTER_R, startDeg);
  const [x2, y2] = polar(OUTER_R, endDeg);
  const [x3, y3] = polar(INNER_R, endDeg);
  const [x4, y4] = polar(INNER_R, startDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M${x1} ${y1} A${OUTER_R} ${OUTER_R} 0 ${large} 1 ${x2} ${y2} `
       + `L${x3} ${y3} A${INNER_R} ${INNER_R} 0 ${large} 0 ${x4} ${y4} Z`;
}

export class PieMenu {
  /**
   * @param container      element the SVG is placed in
   * @param options.id     prefix for gaze target ids, e.g. 'tapperPie'
   * @param options.labels text per segment (its length sets the number of segments)
   * @param options.targets GazeTargets instance
   * @param options.onSegmentBlink (index) => void
   * @param options.onHubBlink / onHubDoubleBlink  optional hub actions
   */
  constructor(container, { id, labels, targets, onSegmentBlink, onHubBlink, onHubDoubleBlink }) {
    this.count = labels.length;
    this.svg = svgEl('svg', { viewBox: '-100 -100 200 200', class: 'pie-svg' });
    container.appendChild(this.svg);

    // Segments
    const span = 360 / this.count;
    this.segments = labels.map((text, i) => {
      const g = svgEl('g', { class: 'seg' });
      g.appendChild(svgEl('path', { d: segmentPath(i * span + GAP_DEG / 2, (i + 1) * span - GAP_DEG / 2) }));
      const [lx, ly] = polar(LABEL_R, (i + 0.5) * span);
      const label = svgEl('text', { x: lx, y: ly, class: 'seg-label' });
      label.textContent = text;
      g.appendChild(label);
      this.svg.appendChild(g);
      return g;
    });

    // Hub: a circle with two lines of text
    this.hub = svgEl('g', { class: 'hub' });
    this.hub.appendChild(svgEl('circle', { r: HUB_R }));
    this.hubMain = svgEl('text', { y: -6, class: 'hub-main' });
    this.hubSub = svgEl('text', { y: 12, class: 'hub-sub' });
    this.hub.append(this.hubMain, this.hubSub);
    this.svg.appendChild(this.hub);

    // Screen geometry (centre + scale), refreshed when the pie changes size
    this.geom = { cx: 0, cy: 0, scale: 1 };
    const measure = () => {
      const r = this.svg.getBoundingClientRect();
      this.geom = { cx: r.left + r.width / 2, cy: r.top + r.height / 2, scale: Math.min(r.width, r.height) / 200 };
    };
    new ResizeObserver(measure).observe(this.svg);
    window.addEventListener('resize', measure);
    measure();

    // Gaze targets
    this.segments.forEach((g, i) => targets.add({
      id: `${id}-seg-${i}`,
      el: g,
      contains: (x, y) => this.segmentAt(x, y) === i,
      onBlink: () => onSegmentBlink(i),
    }));
    if (onHubBlink || onHubDoubleBlink) {
      targets.add({
        id: `${id}-hub`,
        el: this.hub,
        contains: (x, y) => this.radiusAt(x, y) <= HUB_R,
        onBlink: onHubBlink,
        onDoubleBlink: onHubDoubleBlink,
      });
    }
  }

  /** Distance of page point (x, y) from the centre, in SVG units. */
  radiusAt(x, y) {
    const { cx, cy, scale } = this.geom;
    return Math.hypot(x - cx, y - cy) / scale;
  }

  /** Index of the segment under page point (x, y), or -1. Gaps count as segment. */
  segmentAt(x, y) {
    const r = this.radiusAt(x, y);
    if (r < INNER_R || r > OUTER_R) return -1;
    const { cx, cy } = this.geom;
    const deg = (Math.atan2(y - cy, x - cx) * 180) / Math.PI + 90;   // 0 = top
    return Math.floor(((deg + 360) % 360) / (360 / this.count)) % this.count;
  }

  /** Switch a CSS state class on one segment. */
  setSegmentClass(i, cls, on) { this.segments[i].classList.toggle(cls, on); }

  /** Briefly add a class to a segment (e.g. 'playing' when a tapper hits). */
  flashSegment(i, cls, ms) {
    const g = this.segments[i];
    g.classList.add(cls);
    clearTimeout(g[`_flash_${cls}`]);
    g[`_flash_${cls}`] = setTimeout(() => g.classList.remove(cls), ms);
  }

  setHubText(main, sub = '') {
    this.hubMain.textContent = main;
    this.hubSub.textContent = sub;
  }
}
