// Shared coordinate system. Every module projects lat/lon through here so the
// map, landmarks and spawn points agree. Changing ORIGIN or SCALE moves the whole world.

export const ORIGIN = { lat: 31.975, lon: 34.775 };

// World units per real metre. 1.2 makes a residential street read as narrow and a
// boulevard like Moshe Dayan about twice that next to the ~5-unit avatars (founder, 2026-10-15).
export const SCALE = 1.2;

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320 * Math.cos((ORIGIN.lat * Math.PI) / 180);

// x grows east, z grows south (north is -z, matching a default three.js camera).
export function project(lat, lon) {
  return {
    x: (lon - ORIGIN.lon) * M_PER_DEG_LON * SCALE,
    z: -(lat - ORIGIN.lat) * M_PER_DEG_LAT * SCALE,
  };
}

export function unproject(x, z) {
  return {
    lat: ORIGIN.lat - z / (M_PER_DEG_LAT * SCALE),
    lon: ORIGIN.lon + x / (M_PER_DEG_LON * SCALE),
  };
}
