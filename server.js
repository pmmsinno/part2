const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingInterval: 10000,
  pingTimeout: 5000,
});

app.use(express.static(path.join(__dirname, "public")));

// ─── Difficulty Progression ──────────────────────────────────
const DIFFICULTY = [
  { gracePeriodMs: 1000, greenDuration: { min: 3000, max: 5500 }, redDuration: { min: 2000, max: 3500 }, progressRate: 1.2 },
  { gracePeriodMs: 850, greenDuration: { min: 2500, max: 5000 }, redDuration: { min: 1800, max: 3200 }, progressRate: 1.1 },
  { gracePeriodMs: 700, greenDuration: { min: 2000, max: 4000 }, redDuration: { min: 1500, max: 3000 }, progressRate: 1.0 },
  { gracePeriodMs: 600, greenDuration: { min: 1500, max: 3500 }, redDuration: { min: 1500, max: 2800 }, progressRate: 0.9 },
  { gracePeriodMs: 500, greenDuration: { min: 1000, max: 2500 }, redDuration: { min: 1200, max: 2500 }, progressRate: 0.8 },
];

function getDifficulty(round) {
  return DIFFICULTY[Math.min(Math.max(round - 1, 0), DIFFICULTY.length - 1)];
}

function getRoundLabel(round) {
  const labels = ["WARM-UP", "GETTING HARDER", "SERIOUS", "INTENSE", "MAXIMUM"];
  return labels[Math.min(Math.max(round - 1, 0), labels.length - 1)];
}

// ─── Game State ──────────────────────────────────────────────
const game = {
  phase: "lobby",
  light: "red",
  players: new Map(),
  round: 0,
  lightTimer: null,
  graceTimer: null,
  countdownTimer: null,
  progressToWin: 100,
  eliminationPending: false,
  eliminationOrder: [],
  finishOrder: [],
  // Track names used in current tournament to prevent rejoining
  usedNames: new Set(),
  tournamentActive: false, // true once first round starts, false on lobby reset
};

function createPlayer(id, name) {
  return {
    id, name: name.substring(0, 15),
    progress: 0, alive: true, holding: false,
    eliminated: false, finishedAt: null, eliminatedInRound: null,
  };
}

function getPlayersArray() {
  return Array.from(game.players.values()).map((p) => ({
    id: p.id, name: p.name, progress: p.progress,
    alive: p.alive, holding: p.holding,
    finishedAt: p.finishedAt, eliminatedInRound: p.eliminatedInRound,
  }));
}

function getAlivePlayers() {
  return Array.from(game.players.values()).filter((p) => p.alive);
}

function getAliveUnfinished() {
  return Array.from(game.players.values()).filter((p) => p.alive && !p.finishedAt);
}

function getCurrentDifficulty() {
  return getDifficulty(game.round || 1);
}

function getLeaderboard() {
  const entries = [];
  // Winners first
  game.finishOrder.forEach((f, i) => {
    entries.push({ name: f.name, id: f.id, position: i + 1, status: "winner", round: f.round });
  });
  // Alive (not finished)
  const alive = Array.from(game.players.values()).filter(p => p.alive && !p.finishedAt);
  alive.sort((a, b) => b.progress - a.progress);
  alive.forEach((p) => {
    entries.push({ name: p.name, id: p.id, position: entries.length + 1, status: "alive", round: null });
  });
  // Eliminated (last eliminated = worst)
  [...game.eliminationOrder].reverse().forEach((e) => {
    entries.push({ name: e.name, id: e.id, position: entries.length + 1, status: "eliminated", round: e.round });
  });
  return entries;
}

function getPlayerPosition(playerId) {
  const lb = getLeaderboard();
  const entry = lb.find(e => e.id === playerId);
  return entry ? { position: entry.position, total: lb.length, status: entry.status } : null;
}

function broadcastGameState() {
  const diff = getCurrentDifficulty();
  io.to("tv").emit("gameState", {
    phase: game.phase,
    light: game.light,
    players: getPlayersArray(),
    round: game.round,
    tournamentActive: game.tournamentActive,
    difficulty: { gracePeriodMs: diff.gracePeriodMs, roundLabel: getRoundLabel(game.round) },
    leaderboard: getLeaderboard(),
  });
}

function broadcastToPhones() {
  game.players.forEach((player) => {
    const pos = getPlayerPosition(player.id);
    io.to(player.id).emit("playerState", {
      phase: game.phase,
      light: game.light,
      progress: player.progress,
      alive: player.alive,
      holding: player.holding,
      round: game.round,
      position: pos,
      tournamentActive: game.tournamentActive,
    });
  });
}

function broadcastAll() {
  broadcastGameState();
  broadcastToPhones();
}

// ─── Progress ────────────────────────────────────────────────
let progressInterval = null;

function startProgressTracking() {
  if (progressInterval) clearInterval(progressInterval);
  progressInterval = setInterval(() => {
    // Double-check phase AND light to prevent race condition
    if (game.phase !== "playing" || game.light !== "green") return;

    const diff = getCurrentDifficulty();
    let someoneFinished = false;
    game.players.forEach((player) => {
      if (player.alive && player.holding && !player.finishedAt) {
        player.progress = Math.min(game.progressToWin, player.progress + diff.progressRate);
        if (player.progress >= game.progressToWin) {
          player.finishedAt = Date.now();
          someoneFinished = true;
          game.finishOrder.push({ id: player.id, name: player.name, round: game.round });
        }
      }
    });
    broadcastAll();
    if (someoneFinished) checkForGameEnd();
  }, 100);
}

function stopProgressTracking() {
  if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
}

// ─── Light Switching ─────────────────────────────────────────
function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function switchToGreen() {
  if (game.phase !== "playing") return;
  // Check if any alive unfinished players remain
  if (getAliveUnfinished().length === 0) { checkForGameEnd(); return; }
  game.light = "green";
  game.eliminationPending = false;
  broadcastAll();
  const diff = getCurrentDifficulty();
  game.lightTimer = setTimeout(() => switchToRed(), randomBetween(diff.greenDuration.min, diff.greenDuration.max));
}

function switchToRed() {
  if (game.phase !== "playing") return;
  game.light = "red";
  game.eliminationPending = true;
  broadcastAll();
  const diff = getCurrentDifficulty();
  game.graceTimer = setTimeout(() => eliminateHolders(), diff.gracePeriodMs);
}

function eliminatePlayer(player) {
  player.alive = false;
  player.eliminated = true;
  player.holding = false;
  player.eliminatedInRound = game.round;
  game.eliminationOrder.push({ id: player.id, name: player.name, round: game.round });
}

function eliminateHolders() {
  if (game.phase !== "playing" || game.light !== "red") return;
  game.eliminationPending = false;

  const eliminated = [];
  game.players.forEach((player) => {
    if (player.alive && player.holding) {
      eliminatePlayer(player);
      eliminated.push({ id: player.id, name: player.name });
    }
  });

  if (eliminated.length > 0) {
    io.to("tv").emit("eliminations", eliminated);
    eliminated.forEach((e) => {
      const pos = getPlayerPosition(e.id);
      io.to(e.id).emit("eliminated", { position: pos });
    });
  }

  broadcastAll();

  // Check game state
  const alive = getAlivePlayers();
  if (alive.length === 0) { endGame(null); return; }
  if (alive.length === 1 && !alive[0].finishedAt) {
    game.finishOrder.push({ id: alive[0].id, name: alive[0].name, round: game.round });
    alive[0].finishedAt = Date.now();
    endGame(alive[0]);
    return;
  }
  if (getAliveUnfinished().length === 0) { checkForGameEnd(); return; }

  const diff = getCurrentDifficulty();
  game.lightTimer = setTimeout(() => switchToGreen(), randomBetween(diff.redDuration.min, diff.redDuration.max));
}

function checkForGameEnd() {
  const alive = getAlivePlayers();
  const unfinished = getAliveUnfinished();

  if (alive.length === 0) { endGame(null); return; }

  // If someone finished this round
  const roundFinishers = game.finishOrder.filter(f => f.round === game.round);
  if (roundFinishers.length > 0) {
    const winner = game.players.get(roundFinishers[0].id);
    endGame(winner);
    return;
  }

  // If only 1 alive and unfinished, they win
  if (unfinished.length === 1 && alive.length === 1) {
    const winner = unfinished[0];
    game.finishOrder.push({ id: winner.id, name: winner.name, round: game.round });
    winner.finishedAt = Date.now();
    endGame(winner);
    return;
  }
}

function endGame(winner) {
  if (game.phase === "gameOver") return; // Prevent double-call
  game.phase = "gameOver";
  clearTimeout(game.lightTimer);
  clearTimeout(game.graceTimer);
  stopProgressTracking();
  game.light = "red";

  const leaderboard = getLeaderboard();

  io.to("tv").emit("gameOver", {
    winner: winner ? { id: winner.id, name: winner.name } : null,
    players: getPlayersArray(),
    round: game.round,
    leaderboard: leaderboard,
  });

  game.players.forEach((player) => {
    const pos = getPlayerPosition(player.id);
    io.to(player.id).emit("playerState", {
      phase: "gameOver", light: "red",
      progress: player.progress, alive: player.alive,
      holding: false, round: game.round, position: pos,
      tournamentActive: game.tournamentActive,
    });
  });
}

function startGame() {
  const alive = getAlivePlayers();
  if (alive.length < 1) return;

  game.tournamentActive = true;
  game.phase = "countdown";
  game.round++;
  game.light = "red";

  // Reset only alive players' round state
  game.players.forEach((player) => {
    if (player.alive) {
      player.progress = 0;
      player.holding = false;
      player.finishedAt = null;
    }
  });

  const diff = getCurrentDifficulty();
  io.to("tv").emit("roundInfo", { round: game.round, label: getRoundLabel(game.round), gracePeriodMs: diff.gracePeriodMs });

  broadcastAll();

  let count = 3;
  io.to("tv").emit("countdown", count);
  // Only send countdown to alive players
  game.players.forEach((p) => { if (p.alive) io.to(p.id).emit("countdown", count); });

  game.countdownTimer = setInterval(() => {
    count--;
    if (count > 0) {
      io.to("tv").emit("countdown", count);
      game.players.forEach((p) => { if (p.alive) io.to(p.id).emit("countdown", count); });
    } else {
      clearInterval(game.countdownTimer);
      game.phase = "playing";
      startProgressTracking();
      switchToGreen();
    }
  }, 1000);
}

function resetLobby() {
  game.phase = "lobby";
  game.light = "red";
  game.round = 0;
  game.eliminationOrder = [];
  game.finishOrder = [];
  game.usedNames.clear();
  game.tournamentActive = false;
  clearTimeout(game.lightTimer);
  clearTimeout(game.graceTimer);
  clearInterval(game.countdownTimer);
  stopProgressTracking();

  game.players.forEach((player) => io.to(player.id).emit("lobbyReset"));
  game.players.clear();
  broadcastAll();
}

// ─── Softlock detection — check if game should end due to disconnects ──
function checkSoftlock() {
  if (game.phase !== "playing") return;
  const alive = getAlivePlayers();
  if (alive.length === 0) { endGame(null); return; }
  if (alive.length === 1) {
    const winner = alive[0];
    if (!winner.finishedAt) {
      game.finishOrder.push({ id: winner.id, name: winner.name, round: game.round });
      winner.finishedAt = Date.now();
    }
    endGame(winner);
  }
}

// ─── QR Code endpoint ────────────────────────────────────────
app.get("/qr", async (req, res) => {
  try {
    const protocol = req.headers["x-forwarded-proto"] || req.protocol;
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const url = `${protocol}://${host}/phone.html`;
    const qr = await QRCode.toDataURL(url, { width: 400, margin: 2, color: { dark: "#1a1a2e", light: "#ffffff" } });
    res.json({ qr, url });
  } catch (err) {
    res.status(500).json({ error: "QR generation failed" });
  }
});

// ─── Socket.io ───────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`Connected: ${socket.id}`);

  socket.on("joinTV", () => {
    socket.join("tv");
    broadcastGameState();
  });

  socket.on("joinGame", (name) => {
    if (!name || name.trim().length === 0) {
      socket.emit("joinError", "Please enter a name!");
      return;
    }

    const cleanName = name.trim().substring(0, 15);

    // Block joining if tournament is active (prevents eliminated players from refreshing and rejoining)
    if (game.tournamentActive) {
      socket.emit("joinError", "Tournament in progress! Wait for a new game.");
      return;
    }

    if (game.phase !== "lobby") {
      socket.emit("joinError", "Game in progress. Wait for next game!");
      return;
    }

    // Check duplicate names
    const nameLower = cleanName.toLowerCase();
    const existingNames = Array.from(game.players.values()).map(p => p.name.toLowerCase());
    if (existingNames.includes(nameLower)) {
      socket.emit("joinError", "Name already taken! Pick another.");
      return;
    }

    const player = createPlayer(socket.id, cleanName);
    game.players.set(socket.id, player);
    game.usedNames.add(nameLower);

    socket.emit("joined", { id: player.id, name: player.name });
    io.to("tv").emit("playerJoined", { id: player.id, name: player.name });
    broadcastGameState();
    console.log(`Player joined: ${player.name} (${socket.id})`);
  });

  socket.on("holdStart", () => {
    const player = game.players.get(socket.id);
    // Strict check: must be alive, not eliminated, not finished, and game must be playing
    if (!player || !player.alive || player.eliminated || player.finishedAt || game.phase !== "playing") return;
    player.holding = true;

    // Immediate elimination if holding during confirmed red
    if (game.light === "red" && !game.eliminationPending) {
      eliminatePlayer(player);
      io.to("tv").emit("eliminations", [{ id: player.id, name: player.name }]);
      const pos = getPlayerPosition(player.id);
      socket.emit("eliminated", { position: pos });
      broadcastAll();
      checkSoftlock();
    }
  });

  socket.on("holdEnd", () => {
    const player = game.players.get(socket.id);
    if (!player) return;
    player.holding = false;
  });

  socket.on("startGame", () => {
    if (game.phase === "lobby" || game.phase === "gameOver") {
      const alive = getAlivePlayers();
      if (alive.length >= 2) {
        startGame();
      } else if (alive.length === 1) {
        // Only 1 player left — they win by default, end tournament
        const winner = alive[0];
        game.finishOrder.push({ id: winner.id, name: winner.name, round: game.round + 1 });
        winner.finishedAt = Date.now();
        game.round++;
        endGame(winner);
      }
    }
  });

  socket.on("resetLobby", () => resetLobby());

  socket.on("kickPlayer", (playerId) => {
    game.players.delete(playerId);
    io.to(playerId).emit("kicked");
    broadcastGameState();
  });

  socket.on("disconnect", () => {
    const player = game.players.get(socket.id);
    if (player) {
      console.log(`Player disconnected: ${player.name}`);
      if (game.phase === "lobby" && !game.tournamentActive) {
        game.players.delete(socket.id);
        game.usedNames.delete(player.name.toLowerCase());
      } else {
        // During tournament: mark as eliminated if alive
        if (player.alive) {
          eliminatePlayer(player);
          io.to("tv").emit("eliminations", [{ id: player.id, name: player.name }]);
        }
        checkSoftlock();
      }
      broadcastAll();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🔴🟢 Red Light Green Light server running on port ${PORT}`);
  console.log(`   TV view:    http://localhost:${PORT}/tv.html`);
  console.log(`   Player view: http://localhost:${PORT}/phone.html`);
});
