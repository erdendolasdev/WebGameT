const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATABASE_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'aethelgard.sqlite');
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

if (DATABASE_PATH !== ':memory:') {
  fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
}

const database = new DatabaseSync(DATABASE_PATH);
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY COLLATE NOCASE,
    salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    username TEXT NOT NULL COLLATE NOCASE REFERENCES users(username) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    player_color TEXT NOT NULL,
    text TEXT NOT NULL,
    time TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS game_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    state_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

function migrateLegacyUsers() {
  const legacyPath = path.join(__dirname, 'data', 'users.json');
  if (!fs.existsSync(legacyPath)) return;
  const legacyUsers = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
  if (!Array.isArray(legacyUsers)) throw new Error('Eski kullanıcı dosyası beklenen biçimde değil.');
  const insertUser = database.prepare(
    'INSERT OR IGNORE INTO users (username, salt, password_hash) VALUES (?, ?, ?)'
  );
  database.exec('BEGIN');
  try {
    for (const user of legacyUsers) {
      if (
        typeof user.username !== 'string' ||
        typeof user.salt !== 'string' ||
        typeof user.passwordHash !== 'string'
      ) {
        throw new Error('Eski kullanıcı kaydı eksik veya bozuk.');
      }
      insertUser.run(user.username, user.salt, user.passwordHash);
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  fs.renameSync(legacyPath, `${legacyPath}.migrated`);
  console.log('[DB] Eski kullanıcı kayıtları SQLite veritabanına taşındı.');
}

migrateLegacyUsers();

const findUser = database.prepare(
  'SELECT username, salt, password_hash AS passwordHash FROM users WHERE username = ? COLLATE NOCASE'
);
const createUser = database.prepare(
  'INSERT INTO users (username, salt, password_hash) VALUES (?, ?, ?)'
);
const saveSession = database.prepare(
  'INSERT INTO sessions (token_hash, username, expires_at) VALUES (?, ?, ?)'
);
const findSession = database.prepare(`
  SELECT users.username
  FROM sessions
  JOIN users ON users.username = sessions.username
  WHERE sessions.token_hash = ? AND sessions.expires_at > ?
`);
const deleteSession = database.prepare('DELETE FROM sessions WHERE token_hash = ?');
const deleteExpiredSessions = database.prepare('DELETE FROM sessions WHERE expires_at <= ?');
const recentChat = database.prepare(`
  SELECT username AS playerName, player_color AS playerColor, text, time
  FROM (
    SELECT id, username, player_color, text, time
    FROM chat_messages
    ORDER BY id DESC
    LIMIT 40
  )
  ORDER BY id ASC
`);
const addChatMessage = database.prepare(
  'INSERT INTO chat_messages (username, player_color, text, time) VALUES (?, ?, ?, ?)'
);
const pruneChatMessages = database.prepare(
  'DELETE FROM chat_messages WHERE id NOT IN (SELECT id FROM chat_messages ORDER BY id DESC LIMIT 2000)'
);
const loadGameState = database.prepare('SELECT state_json FROM game_state WHERE id = 1');
const storeGameState = database.prepare(`
  INSERT INTO game_state (id, state_json, updated_at)
  VALUES (1, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = CURRENT_TIMESTAMP
`);

function sendJson(res, statusCode, body, headers = {}) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(JSON.stringify(body));
}

async function readRequestBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) {
      throw Object.assign(new Error('İstek çok büyük.'), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  try {
    const body = Buffer.concat(chunks).toString('utf8');
    const parsed = JSON.parse(body || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON gövdesi nesne olmalı.');
    }
    return parsed;
  } catch {
    throw Object.assign(new Error('Geçersiz JSON isteği.'), { statusCode: 400 });
  }
}

function getSessionToken(req) {
  const cookieHeader = req.headers.cookie || '';
  const sessionCookie = cookieHeader.split(';').map(cookie => cookie.trim())
    .find(cookie => cookie.startsWith('aethelgard_session='));
  if (!sessionCookie) return null;
  const token = sessionCookie.slice('aethelgard_session='.length);
  return /^[a-f0-9]{64}$/i.test(token) ? token : null;
}

function getSessionUser(req) {
  const token = getSessionToken(req);
  if (!token) return null;
  const now = Date.now();
  deleteExpiredSessions.run(now);
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  return findSession.get(tokenHash, now) || null;
}

function sessionCookie(token, req) {
  const forwardedProtocol = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const secure = req.socket.encrypted || forwardedProtocol === 'https' ? '; Secure' : '';
  return `aethelgard_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure}`;
}

function createSession(user, req, res) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  saveSession.run(tokenHash, user.username, expiresAt);
  res.setHeader('Set-Cookie', sessionCookie(token, req));
  return { username: user.username };
}

async function handleAuthRequest(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/me') {
    const user = getSessionUser(req);
    sendJson(res, 200, { user });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/logout') {
    const token = getSessionToken(req);
    if (token) {
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      deleteSession.run(tokenHash);
    }
    const forwardedProtocol = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const secure = req.socket.encrypted || forwardedProtocol === 'https' ? '; Secure' : '';
    sendJson(res, 200, { user: null }, {
      'Set-Cookie': `aethelgard_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`
    });
    return;
  }

  if (req.method !== 'POST' || !['/api/register', '/api/login'].includes(pathname)) {
    sendJson(res, 404, { error: 'Uç nokta bulunamadı.' });
    return;
  }

  try {
    const { username, password } = await readRequestBody(req);
    if (typeof username !== 'string' || typeof password !== 'string') {
      sendJson(res, 400, { error: 'Kullanıcı adı ve parola gerekli.' });
      return;
    }
    const normalizedUsername = username.trim();
    if (pathname === '/api/register') {
      if (!/^[a-zA-Z0-9_]{3,20}$/.test(normalizedUsername)) {
        sendJson(res, 400, { error: 'Kullanıcı adı 3-20 karakter olmalı; harf, rakam ve _ kullanabilirsin.' });
        return;
      }
      if (password.length < 8 || password.length > 128) {
        sendJson(res, 400, { error: 'Parolan en az 8, en fazla 128 karakter olmalı.' });
        return;
      }

      const salt = crypto.randomBytes(16).toString('hex');
      const passwordHash = crypto.scryptSync(password, salt, 64).toString('hex');
      try {
        createUser.run(normalizedUsername, salt, passwordHash);
      } catch (error) {
        if (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/i.test(error.message)) {
          sendJson(res, 409, { error: 'Bu kullanıcı adı zaten kullanılıyor.' });
          return;
        }
        throw error;
      }
      const user = { username: normalizedUsername };
      sendJson(res, 201, { user: createSession(user, req, res) });
      return;
    }

    const user = findUser.get(normalizedUsername);
    const passwordHash = user ? crypto.scryptSync(password, user.salt, 64).toString('hex') : '';
    const validPassword = user && crypto.timingSafeEqual(
      Buffer.from(passwordHash, 'hex'),
      Buffer.from(user.passwordHash, 'hex')
    );
    if (!validPassword) {
      sendJson(res, 401, { error: 'Kullanıcı adı veya parola hatalı.' });
      return;
    }
    sendJson(res, 200, { user: createSession(user, req, res) });
  } catch (error) {
    console.error('[Auth] İstek işlenemedi:', error);
    sendJson(res, error.statusCode || 500, {
      error: error.statusCode ? error.message : 'İşlem sırasında sunucu hatası oluştu.'
    });
  }
}

const server = http.createServer((req, res) => {
  let requestUrl;
  try {
    requestUrl = new URL(req.url, 'http://localhost');
  } catch {
    sendJson(res, 400, { error: 'Geçersiz istek adresi.' });
    return;
  }
  if (requestUrl.pathname.startsWith('/api/')) {
    handleAuthRequest(req, res, requestUrl.pathname).catch(error => {
      console.error('[API] Beklenmeyen istek hatası:', error);
      sendJson(res, 500, { error: 'Sunucuda beklenmeyen bir hata oluştu.' });
    });
    return;
  }

  let reqPath;
  try {
    reqPath = decodeURIComponent(requestUrl.pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 Bad Request');
    return;
  }
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.resolve(__dirname, `.${reqPath}`);
  if (!filePath.startsWith(`${__dirname}${path.sep}`)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

// ==========================================================================
// ONLINE MULTIPLAYER SUNUCU MİMARİSİ (AETHELGARD 3D REAL-TIME NETWORKING)
// ==========================================================================
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024, perMessageDeflate: false });

// Paylaşılan Dünya ve Oyun Durumu
const gameState = {
  seed: Math.floor(Math.random() * 900000) + 100000,
  resources: { food: 80, wood: 150, stone: 60, gold: 200, colonists: 3, maxPop: 10 },
  harvestedEntities: [],
  buildings: [],
  colonistTargets: {},
  players: new Map()    // Bağlı oyuncular: { id, name, color, cursor: {x, z} }
};

const savedGameState = loadGameState.get();
if (savedGameState) {
  const parsedState = JSON.parse(savedGameState.state_json);
  Object.assign(gameState, parsedState);
  gameState.players = new Map();
  gameState.resources = {
    food: 80,
    wood: 150,
    stone: 60,
    gold: 200,
    colonists: 3,
    maxPop: 10,
    ...parsedState.resources
  };
}

function persistGameState() {
  const { seed, resources, harvestedEntities, buildings, colonistTargets } = gameState;
  storeGameState.run(JSON.stringify({ seed, resources, harvestedEntities, buildings, colonistTargets }));
}

if (!savedGameState) persistGameState();

const PLAYER_COLORS = ['#38bdf8', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#06b6d4'];

function broadcast(msg, excludeWs = null) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

let nextPlayerId = 1;

wss.on('connection', (ws, req) => {
  const playerId = nextPlayerId++;
  const playerColor = PLAYER_COLORS[(playerId - 1) % PLAYER_COLORS.length];
  const authenticatedUser = getSessionUser(req);
  const playerName = authenticatedUser ? authenticatedUser.username : `Lord_${playerId}`;

  const playerInfo = {
    id: playerId,
    name: playerName,
    color: playerColor,
    authenticated: Boolean(authenticatedUser),
    cursor: { x: 0, z: 0 }
  };
  gameState.players.set(ws, playerInfo);

  console.log(`[Online] ${playerName} bağlandı. (Toplam: ${gameState.players.size} Oyuncu)`);

  // 1. Yeni Oyuncuya Dünya Durumunu Gönder (Tam Senkronizasyon)
  const playerList = Array.from(gameState.players.values());
  ws.send(JSON.stringify({
    type: 'INIT_STATE',
    playerId: playerId,
    playerInfo: playerInfo,
    seed: gameState.seed,
    resources: gameState.resources,
    harvestedEntities: gameState.harvestedEntities,
    buildings: gameState.buildings,
    colonistTargets: gameState.colonistTargets,
    chatHistory: recentChat.all(),
    players: playerList
  }));

  // 2. Diğer Oyunculara Yeni Oyuncuyu Duyur
  broadcast({
    type: 'PLAYER_JOINED',
    player: playerInfo,
    playerCount: gameState.players.size
  }, ws);

  // 3. Mesaj Dinleyici
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case 'CURSOR_MOVE':
          playerInfo.cursor = { x: data.x, z: data.z };
          broadcast({
            type: 'PLAYER_CURSOR',
            playerId: playerId,
            x: data.x,
            z: data.z
          }, ws);
          break;

        case 'COMMAND_COLONIST':
          // Kolonist hareket emri
          gameState.colonistTargets[data.colonistId] = { x: data.targetX, z: data.targetZ, task: data.task };
          broadcast({
            type: 'COLONIST_MOVED',
            playerId: playerId,
            colonistId: data.colonistId,
            targetX: data.targetX,
            targetZ: data.targetZ,
            task: data.task
          });
          break;

        case 'HARVEST_RESOURCE':
          // Kaynak toplama emri
          broadcast({
            type: 'HARVEST_STARTED',
            playerId: playerId,
            colonistId: data.colonistId,
            entityId: data.entityId,
            resType: data.resType
          });
          break;

        case 'HARVEST_COMPLETED':
          // Ağaç/Kaya toplandı
          if (!gameState.harvestedEntities.includes(data.entityId)) {
            gameState.harvestedEntities.push(data.entityId);
            if (data.resType === 'wood') gameState.resources.wood += data.amount;
            else if (data.resType === 'stone') gameState.resources.stone += data.amount;
            else if (data.resType === 'food') gameState.resources.food += data.amount;

            persistGameState();
            broadcast({
              type: 'RESOURCE_DEPLETED',
              entityId: data.entityId,
              resType: data.resType,
              amount: data.amount,
              resources: gameState.resources,
              harvesterName: playerInfo.name
            });
          }
          break;

        case 'PLACE_BUILDING':
          // Yeni bina inşaatı
          const building = {
            id: 'bld_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
            defId: data.defId,
            pos: data.pos,
            builderName: playerInfo.name
          };
          gameState.buildings.push(building);
          if (data.cost) {
            gameState.resources.wood -= (data.cost.wood || 0);
            gameState.resources.stone -= (data.cost.stone || 0);
          }
          persistGameState();
          broadcast({
            type: 'BUILDING_PLACED',
            building: building,
            resources: gameState.resources
          });
          break;

        case 'NEW_MAP_REQUEST':
          // Haritayı yeniden oluştur
          gameState.seed = Math.floor(Math.random() * 900000) + 100000;
          gameState.harvestedEntities = [];
          gameState.buildings = [];
          gameState.colonistTargets = {};
          gameState.resources = { food: 80, wood: 150, stone: 60, gold: 200, colonists: 3, maxPop: 10 };
          persistGameState();
          broadcast({
            type: 'RELOAD_WORLD',
            seed: gameState.seed,
            resources: gameState.resources
          });
          break;

        case 'CHAT_MESSAGE':
          if (!playerInfo.authenticated || !getSessionUser(req)) {
            ws.send(JSON.stringify({
              type: 'CHAT_REJECTED',
              reason: 'Sohbete yazmak için giriş yapmalısın.'
            }));
            break;
          }
          if (typeof data.text !== 'string' || !data.text.trim()) break;
          const chatMessage = {
            playerName: playerInfo.name,
            playerColor: playerInfo.color,
            text: data.text.trim().slice(0, 120),
            time: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
          };
          addChatMessage.run(
            chatMessage.playerName,
            chatMessage.playerColor,
            chatMessage.text,
            chatMessage.time
          );
          pruneChatMessages.run();
          broadcast({
            type: 'CHAT_MESSAGE',
            playerId: playerId,
            ...chatMessage
          });
          break;
      }
    } catch (e) {
      console.error('Mesaj işleme hatası:', e);
    }
  });

  ws.on('close', () => {
    gameState.players.delete(ws);
    console.log(`[Online] ${playerName} ayrıldı. (Kalan: ${gameState.players.size})`);
    broadcast({
      type: 'PLAYER_LEFT',
      playerId: playerId,
      playerCount: gameState.players.size
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Aethelgard 3D sunucusu ${HOST}:${PORT} üzerinde aktif. SQLite: ${DATABASE_PATH}`);
});
