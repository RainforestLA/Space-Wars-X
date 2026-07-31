/** Shared game constants — imported by client and server */

export const TICK_RATE = 30; // server simulation Hz
export const SNAPSHOT_RATE = 20; // network state broadcast Hz
export const MAX_PLAYERS = 20;
export const ARENA_W = 3200;
export const ARENA_H = 2400;

export const SHIP = {
  radius: 14,
  thrust: 280,
  rotateSpeed: 3.8, // rad/s
  maxSpeed: 420,
  drag: 0.12, // light drag for feel (not pure vacuum)
  laserHitsToKill: 2,
  photonCooldown: 10,
  laserCooldown: 0.5,
  shieldDuration: 1,
  shieldCooldown: 10,
  hyperspaceCooldown: 60,
  invulnSpawn: 2,
  /** Hidden voice "Nuke" — expanding pulse wave */
  nukeCooldown: 18,
  /** ~half a typical viewport / quarter of shorter arena axis */
  nukeMaxRadius: 600,
  nukeExpandSpeed: 1100, // world units / sec
  nukeRingWidth: 36,
};

/**
 * Gravity scale — noticeable pull near wells, escapable with moderate thrust.
 * Force ≈ |strength| * GRAVITY_CONSTANT / dist²
 * (was 14e6 — too strong; ~3.2e6 plays well with thrust 280)
 */
export const GRAVITY_CONSTANT = 3_200_000;

export const PROJECTILE = {
  photonSpeed: 1040, // 2× classic speed
  photonRadius: 10, // 2× size
  photonLife: 3.2,
  photonColor: '#3b9eff',
  laserSpeed: 900,
  laserRadius: 3,
  laserLife: 1.2,
  laserColor: '#ff2a2a',
  laserPairDelay: 0.1, // second blast a fraction of a second later
};

export const COLORS = [
  '#5eead4', // teal
  '#f472b6', // pink
  '#a78bfa', // violet
  '#fbbf24', // amber
  '#60a5fa', // blue
  '#4ade80', // green
  '#fb7185', // rose
  '#22d3ee', // cyan
  '#c084fc', // purple
  '#facc15', // yellow
  '#34d399', // emerald
  '#e879f9', // fuchsia
  '#38bdf8', // sky
  '#f97316', // orange
  '#2dd4bf', // teal2
  '#e11d48', // red
  '#818cf8', // indigo
  '#84cc16', // lime
  '#06b6d4', // cyan2
  '#d946ef', // magenta
];

export const TEAM_COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#eab308'];
export const TEAM_NAMES = ['Blue', 'Red', 'Green', 'Gold'];

export const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRoomCode() {
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return code;
}
