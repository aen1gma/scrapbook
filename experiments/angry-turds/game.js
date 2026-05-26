const { Engine, Runner, Bodies, Body, World, Events, Composite } = Matter;

// ── Constants ────────────────────────────────────────────────────────────────

const BIRD_RADIUS      = 18;
const BIRD_FRICTION_AIR = 0.002;
const PIG_RADIUS       = 20;
const PIG_HEALTH       = 2;
const MAX_PULL         = 110;
const LAUNCH_SCALE     = 0.18;
const TRAJ_STEPS       = 90;
const DAMAGE_SPEED     = 2.0;
const ADVANCE_DELAY    = 3000;
const MAX_LEVEL        = 10;
const GRAVITY          = 0.8;

// Slingshot anchor in world coords — set after canvas size is known
let SLING_X, SLING_Y;

// ── State ────────────────────────────────────────────────────────────────────

let engine, runner, canvas, ctx;

let birdQueue    = [];
let pigs         = [];
let activeBird   = null;
let isDragging   = false;
let dragPos      = { x: 0, y: 0 };
let launched     = false;
let gameOver     = false;
let advanceTimer = null;
let currentLevel  = 1;
let leftoverTurds = 0;  // carried forward from previous level win
let restartAction = null;

// ── Init ─────────────────────────────────────────────────────────────────────

function init() {
  canvas = document.getElementById('game-canvas');
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  ctx = canvas.getContext('2d');

  SLING_X = Math.round(canvas.width * 0.18);
  SLING_Y = Math.round(canvas.height - 40 - 85); // 85px above ground

  engine = Engine.create({ gravity: { y: GRAVITY } });
  runner = Runner.create();
  Runner.run(runner, engine);

  buildScene();
  setupInput();
  setupCollisions();
  setupRestartButton();
  setupOrientationCheck();

  requestAnimationFrame(gameLoop);
}

function reset() {
  if (advanceTimer) { clearTimeout(advanceTimer); advanceTimer = null; }
  Runner.stop(runner);
  World.clear(engine.world);
  Engine.clear(engine);

  birdQueue  = [];
  pigs       = [];
  activeBird = null;
  isDragging = false;
  launched   = false;
  gameOver   = false;

  document.getElementById('message-overlay').setAttribute('hidden', '');

  SLING_X = Math.round(canvas.width * 0.18);
  SLING_Y = Math.round(canvas.height - 40 - 85);

  engine = Engine.create({ gravity: { y: GRAVITY } });
  runner = Runner.create();
  Runner.run(runner, engine);

  buildScene();
  setupCollisions();
}

// ── Scene construction ────────────────────────────────────────────────────────

// Returns up to 11 pig spawn positions fanning out from the structure.
// Positions are proportional to W so they stay on-screen across device sizes.
function getPigPositions(W, groundY, cx, count) {
  const r = PIG_RADIUS;
  const s = Math.round(W * 0.065); // ~55 px on an 844-wide phone
  const all = [
    { x: cx,          y: groundY - 111 - r },  // upper beam
    { x: cx + s,      y: groundY - r },         // ground right
    { x: cx - s,      y: groundY - r },         // ground left
    { x: cx + 2 * s,  y: groundY - r },         // ground far right
    { x: cx,          y: groundY - 67 - r },    // lower beam centre
    { x: cx - 2 * s,  y: groundY - r },         // ground far left
    { x: cx + 40,     y: groundY - 67 - r },    // lower beam right
    { x: cx + 3 * s,  y: groundY - r },         // ground further right
    { x: cx - 40,     y: groundY - 67 - r },    // lower beam left
    { x: cx - 3 * s,  y: groundY - r },         // ground further left
    { x: cx + 4 * s,  y: groundY - r },         // ground extreme right
  ];
  return all.slice(0, count);
}

function buildScene() {
  const W = canvas.width;
  const H = canvas.height;
  const groundY = H - 40;   // top surface of ground

  // Ground (static)
  const ground = Bodies.rectangle(W / 2, H - 20, W + 200, 40, {
    isStatic: true, label: 'ground', friction: 0.8, restitution: 0.1,
  });
  World.add(engine.world, ground);

  // Structure center x — designed for phone landscape (~844px wide)
  const cx = Math.round(W * 0.72);

  // Wooden blocks — two pillar pairs + beams + top box
  const blockDefs = [
    { x: cx - 38, y: groundY - 28, w: 18, h: 56 },  // left pillar
    { x: cx + 38, y: groundY - 28, w: 18, h: 56 },  // right pillar
    { x: cx,      y: groundY - 60, w: 90, h: 14 },  // lower beam
    { x: cx - 20, y: groundY - 84, w: 18, h: 34 },  // upper-left pillar
    { x: cx + 20, y: groundY - 84, w: 18, h: 34 },  // upper-right pillar
    { x: cx,      y: groundY -104, w: 54, h: 14 },  // upper beam
  ];

  blockDefs.forEach(({ x, y, w, h }) => {
    const b = Bodies.rectangle(x, y, w, h, {
      label: 'block',
      restitution: 0.1,
      friction: 0.3,
      density: 0.001,
    });
    World.add(engine.world, b);
  });

  // Pigs — count and positions scale with level
  const pigCount  = currentLevel + 1;
  const birdCount = leftoverTurds + 3;

  pigs = getPigPositions(W, groundY, cx, pigCount).map(({ x, y }) => {
    const body = Bodies.circle(x, y, PIG_RADIUS, {
      label: 'pig',
      restitution: 0.3,
      friction: 0.5,
      density: 0.003,
    });
    World.add(engine.world, body);
    return { body, health: PIG_HEALTH, dead: false };
  });

  // Bird queue
  birdQueue = Array.from({ length: birdCount }, () => ({ type: 'red' }));
  mountNextBird();
  updateStatusBar();
}

// ── Bird management ───────────────────────────────────────────────────────────

function mountNextBird() {
  if (birdQueue.length === 0) return;

  activeBird = Bodies.circle(SLING_X, SLING_Y - 20, BIRD_RADIUS, {
    isStatic: true,
    label: 'bird',
    restitution: 0.4,
    friction: 0.5,
    frictionAir: BIRD_FRICTION_AIR,
    density: 0.004,
    collisionFilter: { category: 0x0001, mask: 0 },
  });
  World.add(engine.world, activeBird);
  launched = false;
  isDragging = false;
  dragPos = { x: SLING_X, y: SLING_Y - 20 };
}

function launchBird() {
  if (!activeBird || launched) return;

  const vx = (SLING_X - dragPos.x) * LAUNCH_SCALE;
  const vy = (SLING_Y - dragPos.y) * LAUNCH_SCALE;

  // Only launch if there's meaningful pull
  if (Math.abs(vx) < 0.1 && Math.abs(vy) < 0.1) {
    isDragging = false;
    Body.setPosition(activeBird, { x: SLING_X, y: SLING_Y - 20 });
    return;
  }

  Body.setStatic(activeBird, false);
  activeBird.collisionFilter = { category: 0x0001, mask: 0xFFFFFFFF, group: 0 };
  Body.setVelocity(activeBird, { x: vx, y: vy });
  Body.setAngularVelocity(activeBird, 0.2);

  launched = true;
  isDragging = false;
  birdQueue.shift();
  updateStatusBar();

  advanceTimer = setTimeout(advanceQueue, ADVANCE_DELAY);
}

function advanceQueue() {
  advanceTimer = null;
  if (gameOver) return;

  if (activeBird) {
    World.remove(engine.world, activeBird);
    activeBird = null;
  }

  if (checkWinLose()) return;

  if (birdQueue.length > 0) {
    mountNextBird();
  } else {
    triggerLose();
  }
}

// ── Input ─────────────────────────────────────────────────────────────────────

function setupInput() {
  function canvasCoords(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }

  function onDown(x, y) {
    if (gameOver || launched || !activeBird) return;
    const dx = x - activeBird.position.x;
    const dy = y - activeBird.position.y;
    if (Math.hypot(dx, dy) < BIRD_RADIUS * 3) {
      isDragging = true;
    }
  }

  function onMove(x, y) {
    if (!isDragging) return;
    const dx = x - SLING_X;
    const dy = y - SLING_Y;
    const dist = Math.hypot(dx, dy);
    if (dist > MAX_PULL) {
      const angle = Math.atan2(dy, dx);
      x = SLING_X + Math.cos(angle) * MAX_PULL;
      y = SLING_Y + Math.sin(angle) * MAX_PULL;
    }
    dragPos = { x, y };
    Body.setPosition(activeBird, dragPos);
  }

  function onUp() {
    if (!isDragging) return;
    isDragging = false;
    launchBird();
  }

  canvas.addEventListener('mousedown', e => onDown(e.offsetX, e.offsetY));
  canvas.addEventListener('mousemove', e => onMove(e.offsetX, e.offsetY));
  canvas.addEventListener('mouseup', onUp);
  canvas.addEventListener('mouseleave', onUp);

  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    const c = canvasCoords(e.touches[0].clientX, e.touches[0].clientY);
    onDown(c.x, c.y);
  }, { passive: false });

  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    const c = canvasCoords(e.touches[0].clientX, e.touches[0].clientY);
    onMove(c.x, c.y);
  }, { passive: false });

  canvas.addEventListener('touchend', e => {
    e.preventDefault();
    onUp();
  }, { passive: false });
}

// ── Collisions ────────────────────────────────────────────────────────────────

function setupCollisions() {
  Events.on(engine, 'collisionStart', event => {
    event.pairs.forEach(pair => {
      const { bodyA, bodyB } = pair;

      let pigBody = null;
      if (bodyA.label === 'pig') pigBody = bodyA;
      else if (bodyB.label === 'pig') pigBody = bodyB;
      if (!pigBody) return;

      const other = pigBody === bodyA ? bodyB : bodyA;

      // Relative velocity magnitude at point of impact
      const rvx = bodyA.velocity.x - bodyB.velocity.x;
      const rvy = bodyA.velocity.y - bodyB.velocity.y;
      const speed = Math.hypot(rvx, rvy);
      if (speed < DAMAGE_SPEED) return;

      // Only birds and falling blocks deal damage
      if (other.label !== 'bird' && other.label !== 'block' && other.label !== 'pig') return;

      const pig = pigs.find(p => p.body === pigBody);
      if (!pig || pig.dead) return;

      pig.health -= 1;
      if (pig.health <= 0) {
        pig.dead = true;
        World.remove(engine.world, pig.body);
        checkWinLose();
      }
    });
  });
}

// ── Win / Lose ────────────────────────────────────────────────────────────────

function checkWinLose() {
  if (pigs.every(p => p.dead)) {
    triggerWin();
    return true;
  }
  if (birdQueue.length === 0 && !activeBird) {
    triggerLose();
    return true;
  }
  return false;
}

function triggerWin() {
  gameOver = true;
  Runner.stop(runner);
  // birdQueue still holds any unthrown turds (launched ones have been shifted out)
  const carryOver = birdQueue.length;
  const btn = document.getElementById('restart-btn');
  if (currentLevel < MAX_LEVEL) {
    btn.textContent = 'Next Level →';
    restartAction = () => { leftoverTurds = carryOver; currentLevel++; reset(); updateStatusBar(); };
    showMessage(`Level ${currentLevel}`, 'cleared!');
  } else {
    btn.textContent = 'Play Again';
    restartAction = () => { leftoverTurds = 0; currentLevel = 1; reset(); updateStatusBar(); };
    showMessage('All Done!', 'every level cleared');
  }
}

function triggerLose() {
  gameOver = true;
  Runner.stop(runner);
  leftoverTurds = 0;
  document.getElementById('restart-btn').textContent = 'Try Again';
  restartAction = () => { reset(); updateStatusBar(); };
  showMessage('Game Over', 'out of turds');
}

function showMessage(title, sub) {
  document.getElementById('message-text').textContent = title;
  document.getElementById('message-sub').textContent = sub;
  document.getElementById('message-overlay').removeAttribute('hidden');
}

// ── UI ────────────────────────────────────────────────────────────────────────

function updateStatusBar() {
  document.getElementById('level-display').textContent = `Level ${currentLevel}`;
  document.getElementById('birds-left').textContent    = `Turds: ${birdQueue.length}`;
  document.getElementById('pigs-left').textContent     = `Pigs: ${pigs.filter(p => !p.dead).length}`;
}

function setupRestartButton() {
  document.getElementById('restart-btn').addEventListener('click', () => {
    if (restartAction) restartAction();
  });
}

// ── Drawing ───────────────────────────────────────────────────────────────────

function gameLoop() {
  const W = canvas.width;
  const H = canvas.height;

  ctx.clearRect(0, 0, W, H);

  drawBackground(W, H);
  drawGround(W, H);
  drawBlocks();
  drawSlingshot();
  if (isDragging && activeBird) drawTrajectory();
  drawPigs();
  drawActiveBird();
  drawBirdQueue(H);

  requestAnimationFrame(gameLoop);
}

function drawBackground(W, H) {
  const grad = ctx.createLinearGradient(0, 0, 0, H * 0.75);
  grad.addColorStop(0, '#1a2a4a');
  grad.addColorStop(1, '#0d1a30');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Simple clouds
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  [[W * 0.2, H * 0.12, 55, 18], [W * 0.55, H * 0.08, 40, 14], [W * 0.78, H * 0.18, 50, 16]].forEach(([x, y, rx, ry]) => {
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawGround(W, H) {
  const groundTop = H - 40;
  // Grass
  ctx.fillStyle = '#3a6b20';
  ctx.fillRect(0, groundTop, W, 14);
  // Dirt
  ctx.fillStyle = '#7a4a1a';
  ctx.fillRect(0, groundTop + 14, W, H - groundTop - 14);
}

function drawBlocks() {
  const bodies = Composite.allBodies(engine.world);
  bodies.forEach(body => {
    if (body.label !== 'block') return;
    const { x, y } = body.position;
    const angle = body.angle;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    const verts = body.vertices;
    // Bounding box of first body for size
    const xs = verts.map(v => v.x - x);
    const ys = verts.map(v => v.y - y);

    // Rotate to local and draw
    ctx.beginPath();
    // Use vertices directly in local space
    const local = verts.map(v => ({
      x: (v.x - x) * Math.cos(-angle) - (v.y - y) * Math.sin(-angle),
      y: (v.x - x) * Math.sin(-angle) + (v.y - y) * Math.cos(-angle),
    }));
    ctx.moveTo(local[0].x, local[0].y);
    for (let i = 1; i < local.length; i++) ctx.lineTo(local[i].x, local[i].y);
    ctx.closePath();

    ctx.fillStyle = '#c8902a';
    ctx.fill();
    ctx.strokeStyle = '#6b4a10';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Wood grain lines
    ctx.strokeStyle = 'rgba(107,74,16,0.35)';
    ctx.lineWidth = 1;
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    if (w > h) {
      for (let ly = -h / 2 + 6; ly < h / 2; ly += 8) {
        ctx.beginPath(); ctx.moveTo(-w / 2, ly); ctx.lineTo(w / 2, ly); ctx.stroke();
      }
    } else {
      for (let lx = -w / 2 + 6; lx < w / 2; lx += 8) {
        ctx.beginPath(); ctx.moveTo(lx, -h / 2); ctx.lineTo(lx, h / 2); ctx.stroke();
      }
    }

    ctx.restore();
  });
}

function drawSlingshot() {
  const forkH = 28;
  const trunkH = canvas.height - 40 - SLING_Y; // reach the ground
  const forkSpread = 18;

  ctx.strokeStyle = '#7a4a18';
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';

  // Trunk
  ctx.beginPath();
  ctx.moveTo(SLING_X, SLING_Y);
  ctx.lineTo(SLING_X, SLING_Y + trunkH);
  ctx.stroke();

  // Left tine
  ctx.beginPath();
  ctx.moveTo(SLING_X, SLING_Y);
  ctx.lineTo(SLING_X - forkSpread, SLING_Y - forkH);
  ctx.stroke();

  // Right tine
  ctx.beginPath();
  ctx.moveTo(SLING_X, SLING_Y);
  ctx.lineTo(SLING_X + forkSpread, SLING_Y - forkH);
  ctx.stroke();

  // Elastic bands (only when bird is on sling)
  if (activeBird && !launched) {
    const bx = activeBird.position.x;
    const by = activeBird.position.y;
    const leftTip  = { x: SLING_X - forkSpread, y: SLING_Y - forkH };
    const rightTip = { x: SLING_X + forkSpread, y: SLING_Y - forkH };

    ctx.strokeStyle = '#d4a040';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([]);

    ctx.beginPath(); ctx.moveTo(leftTip.x, leftTip.y); ctx.lineTo(bx, by); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(rightTip.x, rightTip.y); ctx.lineTo(bx, by); ctx.stroke();
  }
}

function drawTrajectory() {
  // Iterative simulation — mirrors Matter.js Verlet integration exactly so the
  // preview line lands on the same path the launched bird will take.
  const DELTA = 1000 / 60;
  const gPerStep = engine.gravity.y * engine.gravity.scale * DELTA * DELTA;
  const airFriction = 1 - BIRD_FRICTION_AIR;

  let vx = (SLING_X - dragPos.x) * LAUNCH_SCALE;
  let vy = (SLING_Y - dragPos.y) * LAUNCH_SCALE;
  let px = dragPos.x;
  let py = dragPos.y;

  ctx.save();
  ctx.setLineDash([5, 7]);
  ctx.strokeStyle = 'rgba(255,240,180,0.55)';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(px, py);

  for (let t = 0; t < TRAJ_STEPS; t++) {
    vx = vx * airFriction;
    vy = vy * airFriction + gPerStep;
    px += vx;
    py += vy;
    ctx.lineTo(px, py);
    if (py > canvas.height + 20) break;
  }

  ctx.stroke();
  ctx.restore();
}

function drawPigs() {
  pigs.forEach(pig => {
    if (pig.dead) return;
    const { x, y } = pig.body.position;
    const angle = pig.body.angle;
    const r = PIG_RADIUS;
    const damaged = pig.health < PIG_HEALTH;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    // Body
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = damaged ? '#3a8a20' : '#4aaa28';
    ctx.fill();
    ctx.strokeStyle = '#2a7a10';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Snout
    ctx.beginPath();
    ctx.ellipse(0, r * 0.35, r * 0.42, r * 0.3, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#3a8a20';
    ctx.fill();
    ctx.strokeStyle = '#2a7a10';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Nostrils
    ctx.fillStyle = '#1a5a08';
    ctx.beginPath(); ctx.arc(-r * 0.14, r * 0.38, r * 0.1, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc( r * 0.14, r * 0.38, r * 0.1, 0, Math.PI * 2); ctx.fill();

    // Eyes
    [[-r * 0.32, -r * 0.18], [r * 0.32, -r * 0.18]].forEach(([ex, ey]) => {
      ctx.beginPath(); ctx.arc(ex, ey, r * 0.26, 0, Math.PI * 2);
      ctx.fillStyle = 'white'; ctx.fill();
      ctx.beginPath(); ctx.arc(ex + r * 0.05, ey + r * 0.05, r * 0.14, 0, Math.PI * 2);
      ctx.fillStyle = '#111'; ctx.fill();
    });

    // Damage crack
    if (damaged) {
      ctx.strokeStyle = '#1a5a08';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-r * 0.1, -r * 0.5);
      ctx.lineTo(r * 0.15, -r * 0.1);
      ctx.lineTo(-r * 0.05, r * 0.2);
      ctx.stroke();
    }

    ctx.restore();
  });
}

// Draws a Mr. Hankey-style angry poop centered at origin, sized by r.
// full=true → eyes + angry brows + frown; false → mini version (eyes only).
function drawPoop(r, full) {
  const brown     = '#8B4513';
  const darkBrown = '#4a1f00';

  // Stacked blobs: bottom → tip
  [
    { ox: 0,         oy: r * 0.22,  br: r * 0.72 },
    { ox: r * 0.06,  oy: -r * 0.26, br: r * 0.52 },
    { ox: r * 0.1,   oy: -r * 0.64, br: r * 0.33 },
    { ox: r * 0.12,  oy: -r * 0.92, br: r * 0.17 },
  ].forEach(({ ox, oy, br }) => {
    ctx.beginPath();
    ctx.arc(ox, oy, br, 0, Math.PI * 2);
    ctx.fillStyle = brown;
    ctx.fill();
  });

  // Shine on bottom blob
  ctx.beginPath();
  ctx.arc(-r * 0.3, r * 0.08, r * 0.18, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(200,130,70,0.4)';
  ctx.fill();

  // Eyes sit on the middle blob (oy ≈ -r*0.26)
  const eyeY = -r * 0.26;
  const eyeX = r * 0.24;
  [-eyeX, eyeX].forEach(ex => {
    ctx.beginPath(); ctx.arc(ex, eyeY, r * 0.2, 0, Math.PI * 2);
    ctx.fillStyle = 'white'; ctx.fill();
    ctx.beginPath(); ctx.arc(ex + r * 0.04, eyeY + r * 0.04, r * 0.11, 0, Math.PI * 2);
    ctx.fillStyle = '#111'; ctx.fill();
  });

  if (full) {
    // Angry V-brows
    ctx.strokeStyle = darkBrown;
    ctx.lineWidth = r * 0.13;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-eyeX - r * 0.3, eyeY - r * 0.3); ctx.lineTo(-eyeX + r * 0.14, eyeY - r * 0.1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo( eyeX + r * 0.3, eyeY - r * 0.3); ctx.lineTo( eyeX - r * 0.14, eyeY - r * 0.1); ctx.stroke();

    // Frown
    ctx.beginPath();
    ctx.arc(r * 0.05, eyeY + r * 0.52, r * 0.22, 0.3, Math.PI - 0.3);
    ctx.strokeStyle = darkBrown;
    ctx.lineWidth = r * 0.11;
    ctx.stroke();
  }
}

function drawActiveBird() {
  if (!activeBird) return;
  const { x, y } = activeBird.position;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(activeBird.angle);
  drawPoop(BIRD_RADIUS, true);
  ctx.restore();
}

function drawBirdQueue(H) {
  const groundY = H - 40;
  const startX  = SLING_X - 55;
  const queueY  = groundY - BIRD_RADIUS * 0.8;
  const spacing = (BIRD_RADIUS * 2) + 6;

  const waiting = birdQueue.slice(launched ? 0 : 1);

  waiting.forEach((_, i) => {
    ctx.save();
    ctx.translate(startX - i * spacing, queueY);
    drawPoop(BIRD_RADIUS * 0.72, false);
    ctx.restore();
  });
}

// ── Orientation ───────────────────────────────────────────────────────────────

function checkOrientation() {
  const portrait = window.innerHeight > window.innerWidth;
  const overlay  = document.getElementById('rotate-overlay');
  const wasShowing = !overlay.hidden;

  if (portrait) {
    overlay.removeAttribute('hidden');
  } else {
    overlay.setAttribute('hidden', '');
    // Recalculate for new dimensions whenever we return to landscape
    if (wasShowing) {
      canvas.width  = window.innerWidth;
      canvas.height = window.innerHeight;
      reset();
      updateStatusBar();
    }
  }
}

function setupOrientationCheck() {
  checkOrientation();

  window.addEventListener('resize', () => {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    checkOrientation();
  });

  // orientationchange fires before dimensions update — wait a frame
  window.addEventListener('orientationchange', () => {
    setTimeout(() => {
      canvas.width  = window.innerWidth;
      canvas.height = window.innerHeight;
      checkOrientation();
    }, 100);
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────

init();
