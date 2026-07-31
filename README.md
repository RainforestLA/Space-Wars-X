# Space Wars X

A modernized, browser-based multiplayer take on the classic 1977 vector game **Space Wars / Spacewar!**. Up to **20 pilots** dogfight in a shared Newtonian arena with gravity wells, photons, lasers, shields, and hyperspace.

## Play

```bash
npm install
npm run dev
```

Open **http://localhost:3000** on any modern browser (desktop, phone, Chromebook). No install required. The app is a **Progressive Web App** — use “Add to Home Screen” / install for a fullscreen experience.

Share a room with `http://localhost:3000/?room=CODE`.

## Controls

| Action | Desktop | Mobile |
|--------|---------|--------|
| Rotate | ← → (or A/D) | Left virtual stick |
| Thrust | Space (or ↑ / W) | Large **THRUST** button |
| Photon / Laser / Shields / Hyperspace | **Voice only** — say the word clearly | Same |

Voice uses the Web Speech API (Chrome/Edge recommended). Allow microphone access when prompted.

## Match modes

- **Free-for-All** (default): one life, last ship standing wins  
- **Team Mode**: 2–4 teams, last team with a living player wins  

Eliminated players become spectators (tap/click to cycle camera targets).

## Host tools

1. Create a private room or public lobby  
2. Optionally open the **Map Editor** — place up to 3 gravity wells (size/strength/style), asteroids, walls, movers, wormholes  
3. Start the match when ready  

If the host disconnects, host privileges transfer to another player.

## Combat reference

| Weapon / ability | Notes |
|------------------|--------|
| **Photon** | Gravity-affected, one-shot kill, 10s cooldown |
| **Laser** | No gravity, 3 hits to kill, 2s cooldown, outline fades with damage |
| **Shields** | 1s invulnerability, 10s recharge |
| **Hyperspace** | Teleport, 60s cooldown, risk of bad re-entry |
| **Ramming** | Mutual destruction (shields can save you) |

## Stack

- **Client**: Canvas 2D, Socket.IO, Web Speech API, Web Audio SFX, PWA service worker  
- **Server**: Node.js, Express, Socket.IO, authoritative simulation @ 30 Hz, snapshots @ 20 Hz  

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Serve client + multiplayer server on port 3000 |
| `npm start` | Same (production static build if `dist/` exists after `npm run build`) |
| `npm run build` | Vite production build into `dist/` |

Set `PORT` to change the listen port.

## Notes

- No accounts required  
- Maps are session-only (no save codes)  
- Best experience: Chrome or Edge with voice permission granted  
