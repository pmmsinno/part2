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
  // Round 1: Very forgiving warm-up
  {
    gracePeriodMs: 1000,
    greenDuration: { min: 3000, max: 5500 },
    redDuration: { min: 2000, max: 3500 },
    progressRate: 3.0,
  },
  // Round 2: Slightly tighter
  {
    gracePeriodMs: 850,
    greenDuration: { min: 2500, max: 5000 },
    redDuration: { min: 1800, max: 3200 },
    progressRate: 2.8,
  },
  // Round 3: Getting serious
  {
    gracePeriodMs: 700,
    greenDuration: { min: 2000, max: 4000 },
    redDuration: { min: 1500, max: 3000 },
    progressRate: 2.5,
  },
  // Round 4: Quick switches
  {
    gracePeriodMs: 600,
    greenDuration: { min: 1500, max: 3500 },
    redDuration: { min: 1500, max: 2800 },
    progressRate: 2.3,
  },
  // Round 5+: Maximum difficulty (floor at 500ms grace)
  {
    gracePeriodMs: 500,
    greenDuration: { min: 1000, max: 2500 },
    redDuration: { min: 1200, max: 2500 },
    progressRate: 2.0,
  },
];

function getDifficulty(round) {
  const index = Math.min(round - 1, DIFFICULTY.length - 1);
  return DIFFICULTY[Math.max(0, index)];
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
  }));
}

function getAlivePlayers() {
  return Array.from(game.players.values()).filter((p) => p.alive);
}

function getCurrentDifficulty() {
  return getDifficulty(game.round || 1);
}

function getRoundLabel(round) {
  if (round <= 1) return "WARM-UP";
  if (round <= 2) return "GETTING HARDER";
  if (round <= 3) return "SERIOUS";
  if (round <= 4) return "INTENSE";
  return "MAXIMUM";
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
  });
}

function broadcastToPhones() {
  game.players.forEach((player) => {
    io.to(player.id).emit("playerState", {
      phase: game.phase,
      light: game.light,
      progress: player.progress,
      alive: player.alive,
      holding: player.holding,
      round: game.round,
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
        }
      }
    });

    broadcastAll();

    if (someoneFinished) {
      checkForWinner();
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
      eliminated.push({ id: player.id, name: player.name });
    }
  });

  if (eliminated.length > 0) {
    io.to("tv").emit("eliminations", eliminated);
    eliminated.forEach((e) => io.to(e.id).emit("eliminated"));
  }

  broadcastAll();

  const alive = getAlivePlayers();
  if (alive.length === 0) { endGame(null); return; }
  if (alive.length === 1) { endGame(alive[0]); return; }

  const diff = getCurrentDifficulty();
  const duration = randomBetween(diff.redDuration.min, diff.redDuration.max);
  game.lightTimer = setTimeout(() => switchToGreen(), duration);
}

function checkForWinner() {
  const finishers = Array.from(game.players.values()).filter((p) => p.finishedAt);
  if (finishers.length > 0) {
    finishers.sort((a, b) => a.finishedAt - b.finishedAt);
    endGame(finishers[0]);
  }
}

function endGame(winner) {
  game.phase = "gameOver";
  clearTimeout(game.lightTimer);
  clearTimeout(game.graceTimer);
  stopProgressTracking();
  game.light = "red";

  io.to("tv").emit("gameOver", {
    winner: winner ? { id: winner.id, name: winner.name } : null,
    players: getPlayersArray(),
    round: game.round,
  });

  broadcastToPhones();
}

function startGame() {
  if (game.players.size < 1) return;

  game.phase = "countdown";
  game.round++;
  game.light = "red";

  const diff = getCurrentDifficulty();
  io.to("tv").emit("roundInfo", {
    round: game.round,
    label: getRoundLabel(game.round),
    gracePeriodMs: diff.gracePeriodMs,
  });

  // Reset player states for new round
  game.players.forEach((player) => {
    player.progress = 0;
    player.alive = true;
    player.holding = false;
    player.eliminated = false;
    player.finishedAt = null;
  });

  broadcastAll();

  let count = 3;
  io.to("tv").emit("countdown", count);
  game.players.forEach((p) => io.to(p.id).emit("countdown", count));

  game.countdownTimer = setInterval(() => {
    count--;
    if (count > 0) {
      io.to("tv").emit("countdown", count);
      game.players.forEach((p) => io.to(p.id).emit("countdown", count));
    } else {
      clearInterval(game.countdownTimer);
      game.phase = "playing";
      startProgressTracking();
      switchToGreen();
    }
  }, 1000);
}

// Full lobby reset — kicks everyone, forces re-sign-in
function resetLobby() {
  game.phase = "lobby";
  game.light = "red";
  game.round = 0;
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

// Next round — keep players, reset progress
function nextRound() {
  game.phase = "lobby";
  game.light = "red";
  clearTimeout(game.lightTimer);
  clearTimeout(game.graceTimer);
  clearInterval(game.countdownTimer);
  stopProgressTracking();

  game.players.forEach((player) => {
    player.progress = 0;
    player.alive = true;
    player.holding = false;
    player.eliminated = false;
    player.finishedAt = null;
  });

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
      io.to("tv").emit("eliminations", [{ id: player.id, name: player.name }]);
      socket.emit("eliminated");
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
  socket.on("nextRound", () => nextRound());

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
        player.alive = false;
        player.holding = false;
      }
      broadcastAll();
    }
  });
});

// ─── Start ───────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🔴🟢 Red Light Green Light server running on port ${PORT}`);
  console.log(`   TV view:    http://localhost:${PORT}/tv.html`);
  console.log(`   Player view: http://localhost:${PORT}/phone.html`);
});
