# 🔴🟢 Red Light Green Light — Multiplayer Game

A real-time multiplayer "Red Light Green Light" game inspired by Squid Game, built for the **IEEE × Tau Beta Pi Qatar Chapter** event at **TAMUQ**.

## How It Works

- **TV Display** (`/tv.html`) — Shows on the big screen. Displays QR code for joining, player list, game state, eliminations, and winner.
- **Phone View** (`/phone.html`) — Players join by scanning the QR code. Hold the screen during green light to make progress. Release during red light or get eliminated!

## Quick Start (Local)

```bash
npm install
npm start
```

Then open:
- **TV:** http://localhost:3000/tv.html
- **Phone:** http://localhost:3000/phone.html

## Deploy to Railway (Recommended)

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) and create a new project
3. Select "Deploy from GitHub repo"
4. Pick this repository
5. Railway auto-detects Node.js — it will run `npm install` and `npm start`
6. Once deployed, you'll get a URL like `https://your-app.up.railway.app`
7. Open `https://your-app.up.railway.app/tv.html` on the TV
8. Players scan the QR code shown on the TV to join!

### Alternative: Deploy via Railway CLI

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

## Game Rules

1. TV shows a QR code — players scan to join and enter their name
2. Host clicks **Start Game** when ready
3. **Green Light** → Players HOLD their screen to run (accumulate progress)
4. **Red Light** → Players must RELEASE immediately
5. Anyone still holding after the grace period (~350ms) is **eliminated**
6. First player to reach 100% progress **wins**
7. If all players are eliminated, nobody wins

## Tuning Game Settings

In `server.js`, you can adjust:

```js
greenDuration: { min: 1500, max: 5000 },  // How long green light lasts (ms)
redDuration: { min: 2000, max: 4000 },     // How long red light lasts (ms)
gracePeriodMs: 350,                         // Grace period after red before checking
progressRate: 2.5,                          // Speed of progress per tick
progressToWin: 100,                         // Progress needed to win
```

## Tech Stack

- **Node.js** + **Express** — Server
- **Socket.io** — Real-time communication
- **qrcode** — QR code generation
- Vanilla HTML/CSS/JS — No framework needed

## Event Day Checklist

- [ ] Deploy to Railway (or run on a laptop)
- [ ] Open TV view on the big screen
- [ ] Test with a few phones before the event
- [ ] Adjust green/red durations if game is too easy or hard
- [ ] Have fun! 🎮
