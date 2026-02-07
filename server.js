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
  {
    gracePeriodMs: 1000,
    greenDuration: { min: 3000, max: 5500 },
    redDuration: { min: 2000, max: 3500 },
    progressRate: 1.2,
  },
  {
    gracePeriodMs: 850,
    greenDuration: { min: 2500, max: 5000 },
    redDuration: { min: 1800, max: 3200 },
    progressRate: 1.1,
  },
  {
    gracePeriodMs: 700,
    greenDuration: { min: 2000, max: 4000 },
    redDuration: { min: 1500, max: 3000 },
    progressRate: 1.0,
  },
  {
    gracePeriodMs: 600,
    greenDuration: { min: 1500, max: 3500 },
    redDuration: { min: 1500, max: 2800 },
    progressRate: 0.9,
  },
  {
    gracePeriodMs: 500,
    greenDuration: { min: 1000, max: 2500 },
    redDuration: { min: 1200, max: 2500 },
    progressRate: 0.8,
  },
];

function getDifficulty(round) {
  const index = Math.min(round - 1, DIFFICULTY.length - 1);
  return DIFFICULTY[Math.max(0, index)];
}

function getRoundLabel(round) {
  if (round <= 1) return "WARM-UP";
  if (round <= 2) return "GETTING HARDER";
  if (round <= 3) return "SERIOUS";
  if (round <= 4) return "INTENSE";
  return "MAXIMUM";
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
  // Leaderboard: tracks elimination order and finishers
  eliminationOrder: [], // { id, name, round, position }
  finishOrder: [], // { id, name, round, position }
};

function createPlayer(id, name) {
  return {
    id,
    name: name.substring(0, 15),
    progress: 0,
    alive: true,
    holding: false,
    eliminated: false,
    finishedAt: null,
    eliminatedInRound: null,
  };
}

function getPlayersArray() {
  return Array.from(game.players.values()).map((p) => ({
    id: p.id,
    name: p.name,
    progress: p.progress,
    alive: p.alive,
    holding: p.holding,
    finishedAt: p.finishedAt,
    eliminatedInRound: p.eliminatedInRound,
  }));
}

function getAlivePlayers() {
  return Array.from(game.players.values()).filter((p) => p.alive);
}

function getCurrentDifficulty() {
  return getDifficulty(game.round || 1);
}

function getLeaderboard() {
  const total = game.players.size;
  // Build leaderboard: finishers at top (by finish order), then alive players, then eliminated (reverse elimination order)
  const entries = [];

  // Winners/finishers first
  game.finishOrder.forEach((f, i) => {
    entries.push({ name: f.name, id: f.id, position: i + 1, status: "winner", round: f.round });
  });

  // Still alive (not finished)
  const alive = Array.from(game.players.values()).filter(p => p.alive && !p.finishedAt);
  alive.sort((a, b) => b.progress - a.progress);
  alive.forEach((p) => {
    entries.push({ name: p.name, id: p.id, position: entries.length + 1, status: "alive", round: null });
  });

  // Eliminated (last eliminated = worst position)
  const elims = [...game.eliminationOrder].reverse();
  elims.forEach((e) => {
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
    difficulty: {
      gracePeriodMs: diff.gracePeriodMs,
      roundLabel: getRoundLabel(game.round),
    },
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
    });
  });
}

function broadcastAll() {
  broadcastGameState();
  broadcastToPhones();
}

// ─── Progress accumulation ───────────────────────────────────
let progressInterval = null;

function startProgressTracking() {
  if (progressInterval) clearInterval(progressInterval);
  progressInterval = setInterval(() => {
    if (game.phase !== "playing" || game.light !== "green") return;

    const diff = getCurrentDifficulty();
    let someoneFinished = false;
    game.players.forEach((player) => {
      if (player.alive && player.holding && !player.finishedAt) {
        player.progress = Math.min(
          game.progressToWin,
          player.progress + diff.progressRate
        );
        if (player.progress >= game.progressToWin) {
          player.finishedAt = Date.now();
          someoneFinished = true;
          game.finishOrder.push({
            id: player.id,
            name: player.name,
            round: game.round,
          });
        }
      }
    });

    broadcastAll();

    if (someoneFinished) {
      checkForGameEnd();
    }
  }, 100);
}

function stopProgressTracking() {
  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = null;
  }
}

// ─── Light Switching ─────────────────────────────────────────
function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function switchToGreen() {
  if (game.phase !== "playing") return;
  game.light = "green";
  game.eliminationPending = false;
  broadcastAll();

  const diff = getCurrentDifficulty();
  const duration = randomBetween(diff.greenDuration.min, diff.greenDuration.max);
  game.lightTimer = setTimeout(() => switchToRed(), duration);
}

function switchToRed() {
  if (game.phase !== "playing") return;
  game.light = "red";
  game.eliminationPending = true;
  broadcastAll();

  const diff = getCurrentDifficulty();
  game.graceTimer = setTimeout(() => eliminateHolders(), diff.gracePeriodMs);
}

function eliminateHolders() {
  if (game.phase !== "playing" || game.light !== "red") return;

  const eliminated = [];
  game.players.forEach((player) => {
    if (player.alive && player.holding) {
      player.alive = false;
      player.eliminated = true;
      player.eliminatedInRound = game.round;
      eliminated.push({ id: player.id, name: player.name });
      game.eliminationOrder.push({
        id: player.id,
        name: player.name,
        round: game.round,
      });
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

  // Check if round/game should end
  const alive = getAlivePlayers().filter(p => !p.finishedAt);
  const totalAlive = getAlivePlayers();

  if (totalAlive.length === 0) {
    endGame(null);
    return;
  }
  if (totalAlive.length === 1 && !totalAlive[0].finishedAt) {
    // Last person standing wins even without finishing
    game.finishOrder.push({
      id: totalAlive[0].id,
      name: totalAlive[0].name,
      round: game.round,
    });
    totalAlive[0].finishedAt = Date.now();
    endGame(totalAlive[0]);
    return;
  }

  const diff = getCurrentDifficulty();
  const duration = randomBetween(diff.redDuration.min, diff.redDuration.max);
  game.lightTimer = setTimeout(() => switchToGreen(), duration);
}

function checkForGameEnd() {
  const alive = getAlivePlayers();
  const unfinished = alive.filter(p => !p.finishedAt);

  // If someone finished
  if (game.finishOrder.length > 0) {
    // End the round — the first finisher of this round wins
    const roundFinishers = game.finishOrder.filter(f => f.round === game.round);
    if (roundFinishers.length > 0) {
      const winner = game.players.get(roundFinishers[0].id);
      endGame(winner);
    }
  }
}

function endGame(winner) {
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

  // Send position to each phone
  game.players.forEach((player) => {
    const pos = getPlayerPosition(player.id);
    io.to(player.id).emit("playerState", {
      phase: "gameOver",
      light: "red",
      progress: player.progress,
      alive: player.alive,
      holding: false,
      round: game.round,
      position: pos,
    });
  });
}

function startGame() {
  const alive = getAlivePlayers();
  if (alive.length < 1) return;

  game.phase = "countdown";
  game.round++;
  game.light = "red";

  // Only reset progress for alive players — eliminated stay eliminated
  game.players.forEach((player) => {
    if (player.alive) {
      player.progress = 0;
      player.holding = false;
      player.finishedAt = null;
    }
  });

  const diff = getCurrentDifficulty();
  io.to("tv").emit("roundInfo", {
    round: game.round,
    label: getRoundLabel(game.round),
    gracePeriodMs: diff.gracePeriodMs,
  });

  broadcastAll();

  let count = 3;
  io.to("tv").emit("countdown", count);
  game.players.forEach((p) => {
    if (p.alive) io.to(p.id).emit("countdown", count);
  });

  game.countdownTimer = setInterval(() => {
    count--;
    if (count > 0) {
      io.to("tv").emit("countdown", count);
      game.players.forEach((p) => {
        if (p.alive) io.to(p.id).emit("countdown", count);
      });
    } else {
      clearInterval(game.countdownTimer);
      game.phase = "playing";
      startProgressTracking();
      switchToGreen();
    }
  }, 1000);
}

// Full lobby reset
function resetLobby() {
  game.phase = "lobby";
  game.light = "red";
  game.round = 0;
  game.eliminationOrder = [];
  game.finishOrder = [];
  clearTimeout(game.lightTimer);
  clearTimeout(game.graceTimer);
  clearInterval(game.countdownTimer);
  stopProgressTracking();

  game.players.forEach((player) => {
    io.to(player.id).emit("lobbyReset");
  });

  game.players.clear();
  broadcastAll();
}

// ─── QR Code endpoint ────────────────────────────────────────
app.get("/qr", async (req, res) => {
  try {
    const protocol = req.headers["x-forwarded-proto"] || req.protocol;
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const url = `${protocol}://${host}/phone.html`;
    const qr = await QRCode.toDataURL(url, {
      width: 400,
      margin: 2,
      color: { dark: "#1a1a2e", light: "#ffffff" },
    });
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
    if (game.phase !== "lobby") {
      socket.emit("joinError", "Game already in progress. Wait for next round!");
      return;
    }
    if (!name || name.trim().length === 0) {
      socket.emit("joinError", "Please enter a name!");
      return;
    }
    const player = createPlayer(socket.id, name.trim());
    game.players.set(socket.id, player);

    socket.emit("joined", { id: player.id, name: player.name });
    io.to("tv").emit("playerJoined", { id: player.id, name: player.name });
    broadcastGameState();
    console.log(`Player joined: ${player.name} (${socket.id})`);
  });

  socket.on("holdStart", () => {
    const player = game.players.get(socket.id);
    if (!player || !player.alive || game.phase !== "playing") return;
    player.holding = true;

    if (game.light === "red" && !game.eliminationPending) {
      player.alive = false;
      player.eliminated = true;
      player.eliminatedInRound = game.round;
      game.eliminationOrder.push({ id: player.id, name: player.name, round: game.round });
      io.to("tv").emit("eliminations", [{ id: player.id, name: player.name }]);
      const pos = getPlayerPosition(player.id);
      socket.emit("eliminated", { position: pos });
      broadcastAll();
    }
  });

  socket.on("holdEnd", () => {
    const player = game.players.get(socket.id);
    if (!player) return;
    player.holding = false;
  });

  socket.on("startGame", () => {
    if (game.phase === "lobby" || game.phase === "gameOver") {
      startGame();
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
      if (game.phase === "lobby") {
        game.players.delete(socket.id);
      } else {
        if (player.alive) {
          player.alive = false;
          player.holding = false;
          player.eliminatedInRound = game.round;
          game.eliminationOrder.push({ id: player.id, name: player.name, round: game.round });
        }
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
