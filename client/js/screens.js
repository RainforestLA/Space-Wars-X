import { net } from './net.js';
import { audio } from './audio.js';
import { TEAM_NAMES, TEAM_COLORS } from '../../shared/constants.js';

export function showScreen(name) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  const el = document.getElementById(`screen-${name}`);
  if (el) el.classList.add('active');
  // Force reflow so subsequent clientWidth/Height reads are non-zero
  if (el) void el.offsetWidth;
}

export function toast(msg, info = false) {
  const el = document.getElementById('toast-global');
  el.textContent = msg;
  el.classList.toggle('info', !!info);
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 3200);
}

export function getPlayerName() {
  const v = document.getElementById('name-input')?.value?.trim();
  if (v) {
    localStorage.setItem('loach_name', v);
    return v.slice(0, 16);
  }
  return localStorage.getItem('loach_name') || 'Pilot';
}

export function initLanding(state) {
  const nameInput = document.getElementById('name-input');
  nameInput.value = localStorage.getItem('loach_name') || '';

  document.getElementById('btn-create').addEventListener('click', () => {
    audio.unlock();
    audio.ui();
    net.createRoom(getPlayerName(), false);
  });
  document.getElementById('btn-create-public').addEventListener('click', () => {
    audio.unlock();
    audio.ui();
    net.createRoom(getPlayerName(), true);
  });
  document.getElementById('btn-join').addEventListener('click', () => {
    audio.unlock();
    audio.ui();
    const code = document.getElementById('code-input').value.trim();
    if (!code) return toast('Enter a room code');
    net.joinRoom(code, getPlayerName());
  });
  document.getElementById('code-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-join').click();
  });
  document.getElementById('btn-refresh-lobbies').addEventListener('click', () => {
    net.listLobbies();
  });

  net.on('lobbies', (list) => renderLobbies(list));
  net.listLobbies();
  // poll lobbies lightly
  setInterval(() => {
    if (document.getElementById('screen-landing')?.classList.contains('active')) {
      net.listLobbies();
    }
  }, 5000);

  // logo ships
  drawLogo();
}

function renderLobbies(list) {
  const ul = document.getElementById('lobby-list');
  const empty = document.getElementById('lobby-empty');
  ul.innerHTML = '';
  if (!list?.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  for (const lob of list) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="code">${lob.code}</span><span class="muted">${lob.players}/${lob.maxPlayers} · ${lob.mode}</span>`;
    li.addEventListener('click', () => {
      audio.unlock();
      document.getElementById('code-input').value = lob.code;
      net.joinRoom(lob.code, getPlayerName());
    });
    ul.appendChild(li);
  }
}

function drawLogo() {
  const c = document.getElementById('logo-canvas');
  if (!c) return;
  const ctx = c.getContext('2d');
  let t = 0;
  function frame() {
    t += 0.02;
    ctx.clearRect(0, 0, c.width, c.height);
    // sun
    const g = ctx.createRadialGradient(140, 60, 0, 140, 60, 28);
    g.addColorStop(0, '#fef08a');
    g.addColorStop(0.6, '#f59e0b');
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(140, 60, 28, 0, Math.PI * 2);
    ctx.fill();
    // ships orbiting
    drawMiniShip(ctx, 140 + Math.cos(t) * 55, 60 + Math.sin(t) * 30, t + Math.PI / 2, '#5eead4');
    drawMiniShip(ctx, 140 + Math.cos(t + Math.PI) * 55, 60 + Math.sin(t + Math.PI) * 30, t + Math.PI + Math.PI / 2, '#f472b6');
    requestAnimationFrame(frame);
  }
  frame();
}

function drawMiniShip(ctx, x, y, angle, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(10, 0);
  ctx.lineTo(-7, 6);
  ctx.lineTo(-3, 0);
  ctx.lineTo(-7, -6);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

export function updateLobbyUI(state) {
  const room = state.room;
  if (!room) return;
  document.getElementById('copy-code').textContent = room.code;
  document.getElementById('player-count').textContent = `${room.players.length}/${room.maxPlayers}`;

  const ul = document.getElementById('player-list');
  ul.innerHTML = '';
  for (const p of room.players) {
    if (p.isBot) continue; // bots only appear in-match
    const li = document.createElement('li');
    if (p.id === state.youId) li.classList.add('you');
    const teamDot =
      room.mode === 'teams' && p.team >= 0
        ? `<span class="swatch" style="background:${TEAM_COLORS[p.team]};color:${TEAM_COLORS[p.team]}"></span>`
        : `<span class="swatch" style="background:${p.color};color:${p.color}"></span>`;
    li.innerHTML = `${teamDot}<span>${escapeHtml(p.name)}${p.id === state.youId ? ' (you)' : ''}</span>`;
    if (p.id === room.hostId) {
      const tag = document.createElement('span');
      tag.className = 'host-tag';
      tag.textContent = 'Host';
      li.appendChild(tag);
    }
    ul.appendChild(li);
  }
  if (room.mode === 'training') {
    const li = document.createElement('li');
    li.innerHTML = `<span class="swatch" style="background:#f97316;color:#f97316"></span><span>Training Drone (AI)</span>`;
    const tag = document.createElement('span');
    tag.className = 'host-tag';
    tag.textContent = 'CPU';
    li.appendChild(tag);
    ul.appendChild(li);
  }

  const isHost = room.hostId === state.youId;
  document.getElementById('host-settings').hidden = !isHost;
  document.getElementById('guest-settings').hidden = isHost;
  const waitMsg = document.getElementById('guest-wait-msg');
  if (waitMsg) {
    waitMsg.textContent =
      room.phase === 'editor'
        ? 'Host is building the map… hang tight!'
        : 'Waiting for host to configure the map and start…';
  }

  if (isHost) {
    document.getElementById('mode-select').value = room.mode;
    document.getElementById('team-count').value = String(room.teamCount);
    document.getElementById('team-count-field').hidden = room.mode !== 'teams';
    document.getElementById('public-check').checked = room.isPublic;
    const frag = document.getElementById('fragmenting-check');
    if (frag) frag.checked = !!room.fragmentingAsteroids;
    const trainHint = document.getElementById('training-hint');
    if (trainHint) trainHint.hidden = room.mode !== 'training';
  }

  // team pick for all in team mode
  const teamPick = document.getElementById('team-pick');
  if (room.mode === 'teams') {
    teamPick.hidden = false;
    if (!isHost) teamPick.hidden = false;
    // also show under host
    renderTeamPick(state, isHost ? document.getElementById('host-settings') : teamPick);
  } else {
    teamPick.hidden = true;
    document.querySelectorAll('.team-pick-host').forEach((e) => e.remove());
  }
}

function renderTeamPick(state, container) {
  let wrap = container.querySelector('.team-pick-host');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'team-pick team-pick-host';
    container.appendChild(wrap);
  }
  wrap.innerHTML = '';
  const me = state.room.players.find((p) => p.id === state.youId);
  for (let i = 0; i < state.room.teamCount; i++) {
    const btn = document.createElement('button');
    btn.className = 'team-btn' + (me?.team === i ? ' selected' : '');
    btn.style.borderColor = TEAM_COLORS[i];
    btn.textContent = TEAM_NAMES[i];
    btn.addEventListener('click', () => {
      net.setTeam(i);
      audio.ui();
    });
    wrap.appendChild(btn);
  }
}

export function bindLobbyControls(state) {
  document.getElementById('mode-select').addEventListener('change', (e) => {
    const mode = e.target.value;
    const teamCount = Number(document.getElementById('team-count').value);
    net.setMode(mode, teamCount);
  });
  document.getElementById('team-count').addEventListener('change', (e) => {
    net.setMode(document.getElementById('mode-select').value, Number(e.target.value));
  });
  document.getElementById('public-check').addEventListener('change', (e) => {
    net.setPublic(e.target.checked);
  });
  document.getElementById('fragmenting-check')?.addEventListener('change', (e) => {
    net.setFragmenting(e.target.checked);
    audio.ui();
  });
  document.getElementById('btn-map-editor').addEventListener('click', () => {
    audio.ui();
    net.enterEditor();
  });
  document.getElementById('btn-start').addEventListener('click', () => {
    audio.ui();
    net.startMatch();
  });
  document.getElementById('btn-leave-lobby').addEventListener('click', () => {
    net.leaveRoom();
  });
  document.getElementById('copy-code').addEventListener('click', async () => {
    const code = state.room?.code;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = code;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    const toastEl = document.getElementById('copy-toast');
    toastEl.classList.remove('hidden');
    setTimeout(() => toastEl.classList.add('hidden'), 1500);
    // share-friendly: also put URL
    try {
      await navigator.clipboard.writeText(`${location.origin}/?room=${code}`);
    } catch (_) {}
  });
}

export function showResults(state, data) {
  showScreen('results');
  audio.win();
  const title = document.getElementById('results-title');
  const sub = document.getElementById('results-sub');
  if (data.winnerId) {
    const w = data.players.find((p) => p.id === data.winnerId);
    title.textContent = 'VICTORY IS YOURS!';
    if (state.room?.mode === 'training') {
      sub.textContent = w?.isBot
        ? 'Training Drone prevailed — try again!'
        : 'You beat the Training Drone!';
    } else {
      sub.textContent = w ? `${w.name} — last ship standing` : 'Last ship standing';
    }
    // If you lost training vs drone, softer title
    if (state.room?.mode === 'training' && w?.isBot) {
      title.textContent = 'DEFEAT';
    }
  } else if (data.winnerTeam != null && data.winnerTeam >= 0) {
    title.textContent = 'VICTORY IS YOURS!';
    sub.textContent = `${TEAM_NAMES[data.winnerTeam]} team — last team standing`;
  } else {
    title.textContent = 'Draw';
    sub.textContent = 'No survivors';
  }

  const list = document.getElementById('results-list');
  list.innerHTML = '';
  const sorted = [...data.players].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  for (const p of sorted) {
    const li = document.createElement('li');
    if (p.id === data.winnerId || (data.winnerTeam != null && p.team === data.winnerTeam && p.alive)) {
      li.classList.add('winner-row');
    }
    li.innerHTML = `<span style="color:${p.color}">${escapeHtml(p.name)}</span><span>K ${p.kills} · D ${p.deaths}</span>`;
    list.appendChild(li);
  }

  const isHost = state.room?.hostId === state.youId;
  document.getElementById('btn-play-again').style.display = isHost ? '' : 'none';
  if (!isHost) {
    sub.textContent += ' · Waiting for host…';
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
