// 2D collision against closed polygons ({ points: [[x, z], ...] }) using a uniform grid hash.
// Movers are circles in the XZ plane; they slide along walls.

const CELL = 20;
const key = (ix, iz) => ix * 73856093 ^ iz * 19349663;
// Coarse bbox grid of whole polygons for isInside. A city has ~100k colliders, and a linear scan
// per isFree() call made crowd and quest spot searches cost seconds at boot. Polygons whose bbox
// spans more than BIG_CELLS cells (sea, large parks) stay in a short list scanned every time.
const PCELL = 64;
const BIG_CELLS = 256;

export class CollisionWorld {
  constructor(colliders = [], bounds = null) {
    this.bounds = bounds;
    this.cells = new Map();
    this.segs = [];
    this.polys = [];
    this.polyCells = new Map();
    this.bigPolys = [];
    for (const c of colliders) this.addPolygon(c);
  }

  addPolygon(c) {
    const pts = c && c.points;
    if (!pts || pts.length < 3) return;
    const pi = this.polys.length;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
    // y0/y1 (optional): absolute vertical extent, so a mover on a bridge deck passes over the
    // pillars, embankment walls and fences of the roads below it (see resolve).
    this.polys.push({ pts, minX, maxX, minZ, maxZ, height: c.height, kind: c.kind || 'building', y0: c.y0, y1: c.y1 });
    const px0 = Math.floor(minX / PCELL), px1 = Math.floor(maxX / PCELL);
    const pz0 = Math.floor(minZ / PCELL), pz1 = Math.floor(maxZ / PCELL);
    if ((px1 - px0 + 1) * (pz1 - pz0 + 1) > BIG_CELLS) this.bigPolys.push(pi);
    else for (let ix = px0; ix <= px1; ix++) for (let iz = pz0; iz <= pz1; iz++) {
      const k = key(ix, iz);
      const cell = this.polyCells.get(k);
      if (cell) cell.push(pi); else this.polyCells.set(k, [pi]);
    }
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (a[0] === b[0] && a[1] === b[1]) continue;
      const si = this.segs.length;
      this.segs.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1], poly: pi });
      this._insert(si, Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]));
    }
  }

  _insert(si, x0, z0, x1, z1) {
    const ix0 = Math.floor(x0 / CELL), ix1 = Math.floor(x1 / CELL);
    const iz0 = Math.floor(z0 / CELL), iz1 = Math.floor(z1 / CELL);
    for (let ix = ix0; ix <= ix1; ix++) for (let iz = iz0; iz <= iz1; iz++) {
      const k = key(ix, iz);
      let cell = this.cells.get(k);
      if (!cell) { cell = []; this.cells.set(k, cell); }
      cell.push(si);
    }
  }

  _gather(x0, z0, x1, z1, out) {
    out.clear();
    const ix0 = Math.floor(x0 / CELL), ix1 = Math.floor(x1 / CELL);
    const iz0 = Math.floor(z0 / CELL), iz1 = Math.floor(z1 / CELL);
    for (let ix = ix0; ix <= ix1; ix++) for (let iz = iz0; iz <= iz1; iz++) {
      const cell = this.cells.get(key(ix, iz));
      if (cell) for (const s of cell) out.add(s);
    }
    return out;
  }

  static pointInPoly(x, z, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i][0], zi = pts[i][1], xj = pts[j][0], zj = pts[j][1];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  }

  // Push a circle out of every nearby polygon. Mutates pos {x, z}. Returns true on contact.
  // With `y` (the mover's feet), polygons that declare a vertical extent (y0/y1) entirely below or
  // above the mover are ignored; polygons without one block at every height, as before.
  resolve(pos, r, y = null) {
    const near = this._tmp || (this._tmp = new Set());
    let hit = false;
    for (let iter = 0; iter < 4; iter++) {
      this._gather(pos.x - r, pos.z - r, pos.x + r, pos.z + r, near);
      let moved = false;
      // Inside a polygon: the closest-point push would point inward, so exit via the nearest edge.
      const polysNear = new Set();
      for (const si of near) {
        const pi = this.segs[si].poly;
        if (y !== null && this._passes(pi, y)) { near.delete(si); continue; }
        polysNear.add(pi);
      }
      for (const pi of polysNear) {
        const p = this.polys[pi];
        if (pos.x < p.minX || pos.x > p.maxX || pos.z < p.minZ || pos.z > p.maxZ) continue;
        if (!CollisionWorld.pointInPoly(pos.x, pos.z, p.pts)) continue;
        let best = Infinity, bx = 0, bz = 0;
        const pts = p.pts;
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i], b = pts[(i + 1) % pts.length];
          const c = closest(pos.x, pos.z, a[0], a[1], b[0], b[1]);
          const d = (c[0] - pos.x) ** 2 + (c[1] - pos.z) ** 2;
          if (d < best) { best = d; bx = c[0]; bz = c[1]; }
        }
        const dx = bx - pos.x, dz = bz - pos.z, d = Math.hypot(dx, dz) || 1e-6;
        pos.x = bx + (dx / d) * (r + 0.01);
        pos.z = bz + (dz / d) * (r + 0.01);
        hit = moved = true;
      }
      if (moved) continue;
      for (const si of near) {
        const s = this.segs[si];
        const c = closest(pos.x, pos.z, s.ax, s.az, s.bx, s.bz);
        const dx = pos.x - c[0], dz = pos.z - c[1];
        const d2 = dx * dx + dz * dz;
        if (d2 < r * r) {
          const d = Math.sqrt(d2) || 1e-6;
          const push = r - d + 0.001;
          pos.x += (dx / d) * push;
          pos.z += (dz / d) * push;
          hit = moved = true;
        }
      }
      if (!moved) break;
    }
    if (this.bounds) {
      const b = this.bounds;
      const cx = Math.min(Math.max(pos.x, b.minX + r), b.maxX - r);
      const cz = Math.min(Math.max(pos.z, b.minZ + r), b.maxZ - r);
      if (cx !== pos.x || cz !== pos.z) { pos.x = cx; pos.z = cz; hit = true; }
    }
    return hit;
  }

  _passes(pi, y) {
    const p = this.polys[pi];
    return (p.y1 != null && y >= p.y1 - 0.4) || (p.y0 != null && y + 3 <= p.y0);
  }

  isInside(x, z) {
    // Large polygons may have no edge near the point, so this goes by polygon bbox, not by edge.
    const cell = this.polyCells.get(key(Math.floor(x / PCELL), Math.floor(z / PCELL)));
    if (cell && this._inAny(cell, x, z)) return true;
    return this._inAny(this.bigPolys, x, z);
  }

  _inAny(list, x, z) {
    for (const pi of list) {
      const p = this.polys[pi];
      if (x < p.minX || x > p.maxX || z < p.minZ || z > p.maxZ) continue;
      if (CollisionWorld.pointInPoly(x, z, p.pts)) return true;
    }
    return false;
  }

  isFree(x, z, r) {
    if (this.isInside(x, z)) return false;
    const near = this._gather(x - r, z - r, x + r, z + r, new Set());
    for (const si of near) {
      const s = this.segs[si];
      const c = closest(x, z, s.ax, s.az, s.bx, s.bz);
      if ((c[0] - x) ** 2 + (c[1] - z) ** 2 < r * r) return false;
    }
    return true;
  }

  // Spiral search for the nearest free spot (used for spawn points).
  findFree(x, z, r) {
    if (this.isFree(x, z, r)) return { x, z };
    for (let ring = 1; ring < 80; ring++) {
      const rad = ring * 3;
      const n = 8 + ring * 2;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const px = x + Math.cos(a) * rad, pz = z + Math.sin(a) * rad;
        if (this.isFree(px, pz, r)) return { x: px, z: pz };
      }
    }
    return { x, z };
  }

  // First hit of segment A->B against any wall, as a fraction t in [0,1], or 1 if clear.
  // Only solid kinds block (the camera may hang over the sea).
  // `skipBelow`: ignore polygons whose known top is under this height. `skipThin`: ignore
  // polygons narrower than this (poles, trunks) — the camera may pass them, the player may not.
  raycast(ax, az, bx, bz, solidOnly = true, { skipBelow = -Infinity, skipThin = 0 } = {}) {
    const near = this._gather(Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz), this._tmp2 || (this._tmp2 = new Set()));
    let best = 1;
    const rx = bx - ax, rz = bz - az;
    for (const si of near) {
      const s = this.segs[si];
      const poly = this.polys[s.poly];
      if (solidOnly && (poly.kind === 'sea' || poly.kind === 'water')) continue;
      if (poly.height != null && poly.height < skipBelow) continue;
      if (skipThin > 0 && Math.max(poly.maxX - poly.minX, poly.maxZ - poly.minZ) < skipThin) continue;
      const sx = s.bx - s.ax, sz = s.bz - s.az;
      const den = rx * sz - rz * sx;
      if (Math.abs(den) < 1e-9) continue;
      const qx = s.ax - ax, qz = s.az - az;
      const t = (qx * sz - qz * sx) / den;
      const u = (qx * rz - qz * rx) / den;
      if (t >= 0 && t < best && u >= 0 && u <= 1) best = t;
    }
    return best;
  }
}

function closest(px, pz, ax, az, bx, bz) {
  const abx = bx - ax, abz = bz - az;
  const l2 = abx * abx + abz * abz;
  let t = l2 > 0 ? ((px - ax) * abx + (pz - az) * abz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return [ax + abx * t, az + abz * t];
}
