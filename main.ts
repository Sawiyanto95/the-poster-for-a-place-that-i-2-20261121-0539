// VELMARA — a travel poster for a place that isn't there.
//
// Pure TypeScript, Node standard library only. The poster is drawn
// programmatically, pixel by pixel, into a 3x supersampled buffer
// (smooth edges), downsampled to 1024x1024, and written as a PNG
// with Node's built-in zlib. No network, no downloaded assets, no
// randomness at runtime beyond a fixed-seed generator, so the output
// is byte-identical on every run.
//
// The place: Velmara, a chain of islands that drift above a sea of
// cloud at sunset. One great island carries a lighthouse; a waterfall
// spills off its edge into the clouds below.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const W = 1024;
const H = 1024;
const SS = 3; // supersampling factor — edges are averaged back down
const SW = W * SS;
const SH = H * SS;
const OUT_DIR = process.env.OUTPUT_DIR ?? "/output";

type RGB = [number, number, number];
type Fill = RGB | ((y: number) => RGB);

const buf = new Uint8Array(SW * SH * 3);

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

// Multi-stop vertical gradient, sampled at logical y in [0, H].
function gradAt(stops: Array<[number, RGB]>, y: number): RGB {
  const t = clamp(y / H, 0, 1);
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      return mix(c0, c1, (t - t0) / (t1 - t0));
    }
  }
  return stops[stops.length - 1][1];
}

function resolveFill(col: Fill, y: number): RGB {
  return typeof col === "function" ? col(y) : col;
}

function setPx(sx: number, sy: number, c: RGB): void {
  if (sx < 0 || sy < 0 || sx >= SW || sy >= SH) return;
  const i = (sy * SW + sx) * 3;
  buf[i] = c[0];
  buf[i + 1] = c[1];
  buf[i + 2] = c[2];
}

function blendPx(sx: number, sy: number, c: RGB, a: number): void {
  if (sx < 0 || sy < 0 || sx >= SW || sy >= SH) return;
  const i = (sy * SW + sx) * 3;
  buf[i] = buf[i] * (1 - a) + c[0] * a;
  buf[i + 1] = buf[i + 1] * (1 - a) + c[1] * a;
  buf[i + 2] = buf[i + 2] * (1 - a) + c[2] * a;
}

function paint(sx: number, sy: number, c: RGB, a: number): void {
  if (a >= 1) setPx(sx, sy, c);
  else if (a > 0) blendPx(sx, sy, c, a);
}

// All scene coordinates below are in logical 1024x1024 space;
// the primitives scale them up to the supersampled buffer.
function fillRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  col: Fill,
  alpha = 1,
): void {
  const sx0 = Math.max(0, Math.floor(x0 * SS));
  const sx1 = Math.min(SW, Math.ceil(x1 * SS));
  const sy0 = Math.max(0, Math.floor(y0 * SS));
  const sy1 = Math.min(SH, Math.ceil(y1 * SS));
  for (let sy = sy0; sy < sy1; sy++) {
    const c = resolveFill(col, sy / SS);
    for (let sx = sx0; sx < sx1; sx++) paint(sx, sy, c, alpha);
  }
}

function fillCircle(
  cx: number,
  cy: number,
  r: number,
  col: Fill,
  alpha = 1,
): void {
  const sy0 = Math.max(0, Math.floor((cy - r) * SS));
  const sy1 = Math.min(SH, Math.ceil((cy + r) * SS));
  for (let sy = sy0; sy < sy1; sy++) {
    const y = (sy + 0.5) / SS;
    const dy = y - cy;
    const dx = Math.sqrt(Math.max(0, r * r - dy * dy));
    const sx0 = Math.max(0, Math.floor((cx - dx) * SS));
    const sx1 = Math.min(SW, Math.ceil((cx + dx) * SS));
    const c = resolveFill(col, y);
    for (let sx = sx0; sx < sx1; sx++) paint(sx, sy, c, alpha);
  }
}

function fillEllipse(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  col: Fill,
  alpha = 1,
): void {
  const sy0 = Math.max(0, Math.floor((cy - ry) * SS));
  const sy1 = Math.min(SH, Math.ceil((cy + ry) * SS));
  for (let sy = sy0; sy < sy1; sy++) {
    const y = (sy + 0.5) / SS;
    const dy = (y - cy) / ry;
    const dx = rx * Math.sqrt(Math.max(0, 1 - dy * dy));
    const sx0 = Math.max(0, Math.floor((cx - dx) * SS));
    const sx1 = Math.min(SW, Math.ceil((cx + dx) * SS));
    const c = resolveFill(col, y);
    for (let sx = sx0; sx < sx1; sx++) paint(sx, sy, c, alpha);
  }
}

// Even-odd scanline polygon fill.
function fillPoly(pts: Array<[number, number]>, col: Fill, alpha = 1): void {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of pts) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const sy0 = Math.max(0, Math.floor(minY * SS));
  const sy1 = Math.min(SH, Math.ceil(maxY * SS));
  for (let sy = sy0; sy < sy1; sy++) {
    const y = (sy + 0.5) / SS;
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % pts.length];
      if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
        xs.push(x0 + ((y - y0) * (x1 - x0)) / (y1 - y0));
      }
    }
    xs.sort((a, b) => a - b);
    const c = resolveFill(col, y);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const sx0 = Math.max(0, Math.floor(xs[k] * SS));
      const sx1 = Math.min(SW, Math.ceil(xs[k + 1] * SS));
      for (let sx = sx0; sx < sx1; sx++) paint(sx, sy, c, alpha);
    }
  }
}

function distSeg(
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x0) * dx + (py - y0) * dy) / len2;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

// Thick round-capped line segment.
function capsule(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
  col: RGB,
): void {
  const sx0 = Math.max(0, Math.floor((Math.min(x0, x1) - r) * SS));
  const sx1 = Math.min(SW, Math.ceil((Math.max(x0, x1) + r) * SS));
  const sy0 = Math.max(0, Math.floor((Math.min(y0, y1) - r) * SS));
  const sy1 = Math.min(SH, Math.ceil((Math.max(y0, y1) + r) * SS));
  for (let sy = sy0; sy < sy1; sy++) {
    const y = (sy + 0.5) / SS;
    for (let sx = sx0; sx < sx1; sx++) {
      const x = (sx + 0.5) / SS;
      if (distSeg(x, y, x0, y0, x1, y1) <= r) setPx(sx, sy, col);
    }
  }
}

function polyline(
  pts: Array<[number, number]>,
  width: number,
  col: RGB,
): void {
  for (let i = 0; i + 1 < pts.length; i++) {
    capsule(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], width / 2, col);
  }
}

// --- A small hand-drawn stroke font -------------------------------------
// Each glyph lives on a 10-wide, 14-tall grid, drawn as thick strokes
// with round caps. Only the letters of VELMARA are needed.
const GLYPHS: Record<string, Array<Array<[number, number]>>> = {
  A: [
    [
      [1, 14],
      [5, 0],
      [9, 14],
    ],
    [
      [3.1, 8.6],
      [6.9, 8.6],
    ],
  ],
  E: [
    [
      [1, 0],
      [1, 14],
    ],
    [
      [1, 0],
      [9, 0],
    ],
    [
      [1, 7],
      [7.6, 7],
    ],
    [
      [1, 14],
      [9, 14],
    ],
  ],
  L: [
    [
      [1, 0],
      [1, 14],
      [9, 14],
    ],
  ],
  M: [
    [
      [1, 14],
      [1, 0],
      [5, 7.6],
      [9, 0],
      [9, 14],
    ],
  ],
  R: [
    [
      [1, 14],
      [1, 0],
      [8.4, 0],
      [8.4, 6.8],
      [1, 6.8],
    ],
    [
      [5.2, 6.8],
      [9.4, 14],
    ],
  ],
  V: [
    [
      [1, 0],
      [5, 14],
      [9, 0],
    ],
  ],
};

function drawText(
  text: string,
  cx: number,
  top: number,
  height: number,
  color: RGB,
): void {
  const scale = height / 14;
  const adv = 11.6;
  const totalUnits = (text.length - 1) * adv + 10;
  let x = cx - (totalUnits * scale) / 2;
  const w = 1.7 * scale;
  for (const ch of text) {
    const glyph = GLYPHS[ch];
    if (glyph) {
      for (const stroke of glyph) {
        for (let i = 0; i + 1 < stroke.length; i++) {
          capsule(
            x + stroke[i][0] * scale,
            top + stroke[i][1] * scale,
            x + stroke[i + 1][0] * scale,
            top + stroke[i + 1][1] * scale,
            w / 2,
            color,
          );
        }
      }
    }
    x += adv * scale;
  }
}

// --- Scene pieces --------------------------------------------------------
function pine(cx: number, baseY: number, h: number): void {
  const green: RGB = [30, 77, 56];
  const trunk: RGB = [74, 50, 38];
  fillRect(cx - 2, baseY - h * 0.22, cx + 2, baseY, trunk);
  const w = h * 0.42;
  fillPoly(
    [
      [cx - w * 0.62, baseY - h * 0.42],
      [cx, baseY - h],
      [cx + w * 0.62, baseY - h * 0.42],
    ],
    green,
  );
  fillPoly(
    [
      [cx - w * 0.8, baseY - h * 0.18],
      [cx, baseY - h * 0.68],
      [cx + w * 0.8, baseY - h * 0.18],
    ],
    green,
  );
  fillPoly(
    [
      [cx - w, baseY - h * 0.02],
      [cx, baseY - h * 0.45],
      [cx + w, baseY - h * 0.02],
    ],
    green,
  );
}

function bird(cx: number, cy: number, s: number): void {
  const col: RGB = [42, 33, 64];
  polyline(
    [
      [cx - 10 * s, cy],
      [cx - 4 * s, cy - 6 * s],
      [cx, cy - 3 * s],
    ],
    2.5 * s,
    col,
  );
  polyline(
    [
      [cx, cy - 3 * s],
      [cx + 4 * s, cy - 6 * s],
      [cx + 10 * s, cy],
    ],
    2.5 * s,
    col,
  );
}

function island(
  rockPts: Array<[number, number]>,
  grassTop: Array<[number, number]>,
): void {
  const rock: Fill = (y) =>
    gradAt(
      [
        [0.48, [107, 66, 88]],
        [0.68, [60, 35, 64]],
      ],
      y,
    );
  // Rock body: the full outline, top edge plus tapered underside.
  fillPoly(rockPts, rock);
  const grass: Fill = (y) =>
    gradAt(
      [
        [0.45, [87, 160, 107]],
        [0.5, [47, 107, 79]],
      ],
      y,
    );
  fillPoly(grassTop, grass);
}

// Fixed-seed generator, so the stars never move between runs.
let seed = 20261121;
function rnd(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
}

function drawScene(): void {
  // 1. Sunset sky.
  const sky: Fill = (y) =>
    gradAt(
      [
        [0, [29, 42, 85]],
        [0.26, [92, 74, 138]],
        [0.46, [184, 90, 114]],
        [0.6, [239, 138, 90]],
        [0.7, [247, 196, 106]],
      ],
      y,
    );
  fillRect(0, 0, W, H, sky);

  // 2. Early stars in the indigo top of the sky.
  for (let i = 0; i < 46; i++) {
    const x = rnd() * W;
    const y = rnd() * 270;
    const r = 0.8 + rnd() * 1.6;
    fillCircle(x, y, r, [255, 233, 192], 0.3 + rnd() * 0.5);
  }

  // 3. The low sun, glowing behind the main island. The glow is built
  // from many faint rings so it fades out without visible steps.
  fillCircle(720, 370, 300, [255, 217, 138], 0.03);
  fillCircle(720, 370, 260, [255, 217, 138], 0.04);
  fillCircle(720, 370, 220, [255, 217, 138], 0.05);
  fillCircle(720, 370, 180, [255, 217, 138], 0.07);
  fillCircle(720, 370, 145, [255, 217, 138], 0.09);
  fillCircle(720, 370, 115, [255, 217, 138], 0.12);
  fillCircle(720, 370, 95, [255, 237, 181]);

  // 4. A far mountain ridge along the horizon.
  fillPoly(
    [
      [0, 706],
      [80, 672],
      [170, 694],
      [250, 662],
      [340, 692],
      [430, 670],
      [520, 696],
      [620, 668],
      [720, 692],
      [820, 664],
      [920, 690],
      [1024, 668],
      [1024, 730],
      [0, 730],
    ],
    (y) =>
      gradAt(
        [
          [0.62, [75, 52, 96]],
          [0.72, [58, 37, 71]],
        ],
        y,
      ),
  );

  // 5. The sea of cloud the islands drift above.
  fillRect(
    0,
    690,
    W,
    800,
    (y) =>
      gradAt(
        [
          [0.67, [246, 207, 158]],
          [0.79, [232, 154, 114]],
        ],
        y,
      ),
  );
  const puffs: Array<[number, number, number, number, RGB, number?]> = [
    [180, 712, 220, 26, [251, 227, 184]],
    [420, 700, 260, 30, [249, 211, 160]],
    [700, 716, 240, 28, [251, 227, 184]],
    [920, 702, 200, 26, [249, 211, 160]],
    [60, 745, 180, 24, [242, 185, 138]],
    [330, 752, 230, 26, [242, 185, 138]],
    [620, 748, 260, 28, [249, 211, 160]],
    [900, 752, 190, 24, [242, 185, 138]],
    [250, 770, 200, 18, [221, 146, 104], 0.55],
    [650, 772, 220, 18, [221, 146, 104], 0.5],
    [950, 775, 140, 16, [221, 146, 104], 0.5],
    [120, 700, 150, 20, [251, 227, 184]],
    [560, 728, 200, 22, [251, 227, 184]],
    [820, 730, 170, 20, [249, 211, 160]],
  ];
  for (const [cx, cy, rx, ry, c, a] of puffs) {
    fillEllipse(cx, cy, rx, ry, c, a ?? 1);
  }
  // Thin mist hugging the horizon.
  fillRect(0, 686, W, 700, [251, 227, 184], 0.35);

  // 6. Small drifting islands, left and right.
  island(
    [
      [128, 600],
      [242, 600],
      [228, 624],
      [205, 644],
      [186, 656],
      [168, 644],
      [142, 622],
    ],
    [
      [126, 602],
      [244, 602],
      [238, 588],
      [200, 584],
      [160, 586],
      [130, 592],
    ],
  );
  pine(185, 588, 30);

  island(
    [
      [795, 548],
      [900, 548],
      [884, 578],
      [862, 600],
      [848, 616],
      [838, 612],
      [820, 585],
      [802, 562],
    ],
    [
      [792, 550],
      [903, 550],
      [898, 534],
      [860, 528],
      [820, 532],
      [796, 540],
    ],
  );
  pine(830, 532, 34);
  pine(872, 530, 28);

  // 7. The main island: grassy top, rocky underside, lighthouse, pines.
  fillPoly(
    [
      [330, 498],
      [688, 498],
      [672, 540],
      [640, 585],
      [600, 625],
      [565, 652],
      [528, 672],
      [512, 678],
      [470, 650],
      [420, 610],
      [372, 560],
      [340, 525],
    ],
    (y) =>
      gradAt(
        [
          [0.48, [107, 66, 88]],
          [0.68, [60, 35, 64]],
        ],
        y,
      ),
  );
  // Rock strata.
  polyline(
    [
      [352, 542],
      [450, 536],
      [560, 544],
      [655, 538],
    ],
    3,
    [46, 26, 48],
  );
  polyline(
    [
      [380, 585],
      [470, 578],
      [580, 588],
      [620, 582],
    ],
    3,
    [46, 26, 48],
  );
  polyline(
    [
      [420, 625],
      [500, 618],
      [560, 626],
    ],
    3,
    [46, 26, 48],
  );
  // Grass cap with a bright rim.
  fillPoly(
    [
      [326, 500],
      [692, 500],
      [686, 480],
      [640, 470],
      [560, 466],
      [470, 468],
      [380, 472],
      [330, 482],
    ],
    (y) =>
      gradAt(
        [
          [0.45, [87, 160, 107]],
          [0.5, [47, 107, 79]],
        ],
        y,
      ),
  );
  polyline(
    [
      [330, 482],
      [380, 472],
      [470, 468],
      [560, 466],
      [640, 470],
      [686, 480],
    ],
    3,
    [143, 206, 155],
  );
  pine(400, 470, 46);
  pine(560, 468, 52);
  pine(625, 472, 40);

  // The lighthouse — the poster's one landmark.
  const white: RGB = [247, 242, 228];
  const dark: RGB = [44, 44, 62];
  fillRect(447, 408, 463, 468, white);
  fillRect(447, 428, 463, 434, dark);
  fillRect(447, 448, 463, 454, dark);
  fillRect(442, 402, 468, 410, dark);
  fillCircle(455, 402, 9, [198, 90, 74]);
  fillCircle(455, 398, 4, [255, 233, 160]);
  fillPoly(
    [
      [455, 394],
      [600, 352],
      [600, 386],
    ],
    [255, 233, 160],
    0.12,
  );
  fillPoly(
    [
      [455, 394],
      [310, 352],
      [310, 386],
    ],
    [255, 233, 160],
    0.12,
  );

  // 8. The waterfall spilling off the main island into the clouds.
  const leftEdge: Array<[number, number]> = [];
  const rightEdge: Array<[number, number]> = [];
  for (let y = 500; y <= 700; y += 10) {
    leftEdge.push([670 + 4 * Math.sin(y / 28), y]);
    rightEdge.push([694 + 4 * Math.sin(y / 28 + 1.2), y]);
  }
  fillPoly(
    [...leftEdge, ...rightEdge.reverse()],
    (y) =>
      gradAt(
        [
          [0.49, [216, 242, 244]],
          [0.69, [168, 216, 222]],
        ],
        y,
      ),
  );
  polyline(
    [
      [676, 505],
      [679, 560],
      [676, 620],
      [679, 690],
    ],
    2,
    [255, 255, 255],
  );
  polyline(
    [
      [686, 505],
      [683, 560],
      [686, 620],
      [683, 690],
    ],
    2,
    [255, 255, 255],
  );
  fillEllipse(684, 700, 34, 12, [255, 255, 255], 0.85);
  fillEllipse(684, 706, 44, 10, [255, 255, 255], 0.6);

  // 9. Birds crossing the evening sky.
  bird(300, 250, 1);
  bird(345, 282, 0.8);
  bird(760, 215, 1.1);
  bird(805, 250, 0.85);
  bird(560, 180, 0.9);

  // 10. The title band: deep teal, gold rules, the name in cream.
  fillRect(0, 800, W, H, [14, 50, 60]);
  fillRect(64, 824, 960, 827, [217, 164, 65]);
  fillRect(64, 994, 960, 997, [217, 164, 65]);
  drawText("VELMARA", 512, 862, 118, [246, 234, 210]);
  fillPoly(
    [
      [128, 912],
      [137, 921],
      [128, 930],
      [119, 921],
    ],
    [217, 164, 65],
  );
  fillPoly(
    [
      [896, 912],
      [905, 921],
      [896, 930],
      [887, 921],
    ],
    [217, 164, 65],
  );

  // 11. A thin cream print border around the whole poster.
  const frame: RGB = [246, 234, 210];
  fillRect(14, 14, 1010, 18, frame, 0.85);
  fillRect(14, 1006, 1010, 1010, frame, 0.85);
  fillRect(14, 14, 18, 1010, frame, 0.85);
  fillRect(1006, 14, 1010, 1010, frame, 0.85);
}

// --- PNG encoding --------------------------------------------------------
const CRC_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function encodePNG(img: Uint8Array): Buffer {
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0; // filter: none
    raw.set(img.subarray(y * W * 3, (y + 1) * W * 3), y * (1 + W * 3) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Box-filter the supersampled buffer down to 1024x1024.
function downsample(): Uint8Array {
  const out = new Uint8Array(W * H * 3);
  const n = SS * SS;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const i = ((y * SS + dy) * SW + (x * SS + dx)) * 3;
          r += buf[i];
          g += buf[i + 1];
          b += buf[i + 2];
        }
      }
      const o = (y * W + x) * 3;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
    }
  }
  return out;
}

function main(): void {
  drawScene();
  const png = encodePNG(downsample());

  // Prepare /output: create it, clear only its contents (the grader
  // mounts the directory itself, so it must never be removed).
  mkdirSync(OUT_DIR, { recursive: true });
  for (const name of readdirSync(OUT_DIR)) {
    rmSync(join(OUT_DIR, name), { recursive: true, force: true });
  }
  writeFileSync(join(OUT_DIR, "entry.png"), png);
  console.log(`wrote ${join(OUT_DIR, "entry.png")} (${png.length} bytes)`);
}

main();
