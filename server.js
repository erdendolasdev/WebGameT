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
  CREATE TABLE IF NOT EXISTS worlds (
    id TEXT PRIMARY KEY,
    owner_username TEXT COLLATE NOCASE REFERENCES users(username),
    name TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('solo', 'shared')),
    seed INTEGER NOT NULL,
    state_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (owner_username)
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
const listWorlds = database.prepare(`
  SELECT id, owner_username AS ownerUsername, name, mode, seed, state_json AS stateJson
  FROM worlds
  WHERE mode = 'shared' OR owner_username = ? COLLATE NOCASE
  ORDER BY created_at ASC
`);
const findWorld = database.prepare(`
  SELECT id, owner_username AS ownerUsername, name, mode, seed, state_json AS stateJson
  FROM worlds WHERE id = ?
`);
const findOwnedWorld = database.prepare('SELECT id FROM worlds WHERE owner_username = ? COLLATE NOCASE');
const insertWorld = database.prepare(`
  INSERT INTO worlds (id, owner_username, name, mode, seed, state_json)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const persistWorldState = database.prepare('UPDATE worlds SET state_json = ? WHERE id = ?');
const hasAnyWorld = database.prepare('SELECT 1 AS found FROM worlds LIMIT 1');
const worldStates = new Map();
const DEFAULT_RESOURCES = { food: 80, wood: 150, stone: 60, gold: 200, colonists: 3, maxPop: 10 };

function createWorldState(row) {
  const saved = JSON.parse(row.stateJson);
  return {
    id: row.id,
    ownerUsername: row.ownerUsername,
    name: row.name,
    mode: row.mode,
    seed: row.seed,
    resources: { ...DEFAULT_RESOURCES, ...saved.resources },
    harvestedEntities: saved.harvestedEntities || [],
    buildings: saved.buildings || [],
    colonistTargets: saved.colonistTargets || {},
    players: new Map()
  };
}

function getWorldState(id) {
  if (worldStates.has(id)) return worldStates.get(id);
  const row = findWorld.get(id);
  if (!row) return null;
  const world = createWorldState(row);
  worldStates.set(id, world);
  return world;
}

function saveWorldState(world) {
  persistWorldState.run(JSON.stringify({
    seed: world.seed,
    resources: world.resources,
    harvestedEntities: world.harvestedEntities,
    buildings: world.buildings,
    colonistTargets: world.colonistTargets
  }), world.id);
}

function migrateLegacyWorld() {
  const savedGameState = loadGameState.get();
  if (!savedGameState || hasAnyWorld.get()) return;
  const saved = JSON.parse(savedGameState.state_json);
  if (saved.initialized === false) return;
  const seed = Number.isInteger(saved.seed) ? saved.seed : Math.floor(Math.random() * 900000) + 100000;
  const state = {
    seed,
    resources: { ...DEFAULT_RESOURCES, ...saved.resources },
    harvestedEntities: saved.harvestedEntities || [],
    buildings: saved.buildings || [],
    colonistTargets: saved.colonistTargets || {}
  };
  insertWorld.run('legacy-world-1', null, 'Aethelgard - Eski Dünya', 'shared', seed, JSON.stringify(state));
  console.log('[DB] Önceki ortak dünya sunucu listesine taşındı.');
}

migrateLegacyWorld();

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

async function handleWorldRequest(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/servers') {
    const worldCount = Number(database.prepare('SELECT COUNT(*) AS count FROM worlds').get().count);
    sendJson(res, 200, {
      servers: [{
        id: 'aethelgard-1',
        name: 'Aethelgard 1',
        status: 'online',
        worlds: worldCount
      }]
    });
    return;
  }

  const user = getSessionUser(req);
  if (!user) {
    sendJson(res, 401, { error: 'Dünyaları görmek veya harita oluşturmak için giriş yapmalısın.' });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/worlds') {
    const worlds = listWorlds.all(user.username).map(row => ({
      id: row.id,
      name: row.name,
      mode: row.mode,
      owner: row.ownerUsername,
      players: worldStates.get(row.id)?.players.size || 0
    }));
    const ownedWorld = findOwnedWorld.get(user.username);
    sendJson(res, 200, {
      server: { id: 'aethelgard-1', name: 'Aethelgard 1' },
      worlds,
      ownedWorldId: ownedWorld ? ownedWorld.id : null
    });
    return;
  }

  if (req.method !== 'POST' || pathname !== '/api/worlds') {
    sendJson(res, 404, { error: 'Uç nokta bulunamadı.' });
    return;
  }

  const existingWorld = findOwnedWorld.get(user.username);
  if (existingWorld) {
    sendJson(res, 409, { error: 'Her hesap yalnızca bir harita oluşturabilir.' });
    return;
  }

  let body;
  try {
    body = await readRequestBody(req);
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message });
    return;
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const mode = body.mode;
  if (name.length < 3 || name.length > 32) {
    sendJson(res, 400, { error: 'Harita adı 3-32 karakter olmalı.' });
    return;
  }
  if (!['solo', 'shared'].includes(mode)) {
    sendJson(res, 400, { error: 'Oyun türü tek kişilik veya ortak olmalı.' });
    return;
  }

  const id = crypto.randomUUID();
  const seed = Math.floor(Math.random() * 900000) + 100000;
  const state = {
    seed,
    resources: DEFAULT_RESOURCES,
    harvestedEntities: [],
    buildings: [],
    colonistTargets: {}
  };
  try {
    insertWorld.run(id, user.username, name, mode, seed, JSON.stringify(state));
  } catch (error) {
    if (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/i.test(error.message)) {
      sendJson(res, 409, { error: 'Her hesap yalnızca bir harita oluşturabilir.' });
      return;
    }
    throw error;
  }
  const world = getWorldState(id);
  sendJson(res, 201, { world: { id, name, mode, owner: user.username, players: world.players.size } });
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
    if (requestUrl.pathname.startsWith('/api/world')) {
      handleWorldRequest(req, res, requestUrl.pathname).catch(error => {
        console.error('[Worlds] İstek işlenemedi:', error);
        sendJson(res, 500, { error: 'Dünya işlemi sırasında sunucu hatası oluştu.' });
      });
      return;
    }
    if (requestUrl.pathname === '/api/servers') {
      handleWorldRequest(req, res, requestUrl.pathname).catch(error => {
        console.error('[Servers] İstek işlenemedi:', error);
        sendJson(res, 500, { error: 'Sunucu listesi alınamadı.' });
      });
      return;
    }
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

const PLAYER_COLORS = ['#38bdf8', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#06b6d4'];

function broadcastAll(msg, excludeWs = null) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

function broadcastWorld(world, msg, excludeWs = null) {
  const data = JSON.stringify(msg);
  world.players.forEach((player, client) => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) client.send(data);
  });
}

function connectedPlayers() {
  return Array.from(wss.clients)
    .filter(client => client.readyState === WebSocket.OPEN && client.playerInfo)
    .map(client => client.playerInfo);
}

let nextPlayerId = 1;

wss.on('connection', (ws, req) => {
  const requestUrl = new URL(req.url, 'http://localhost');
  const playerId = nextPlayerId++;
  const playerColor = PLAYER_COLORS[(playerId - 1) % PLAYER_COLORS.length];
  const authenticatedUser = getSessionUser(req);
  const playerName = authenticatedUser ? authenticatedUser.username : `Lord_${playerId}`;
  const worldId = requestUrl.searchParams.get('world');
  const world = worldId ? getWorldState(worldId) : null;

  if (worldId && (
    !authenticatedUser ||
    !world ||
    (world.mode === 'solo' && world.ownerUsername.toLowerCase() !== authenticatedUser.username.toLowerCase())
  )) {
    ws.send(JSON.stringify({
      type: 'WORLD_ACCESS_DENIED',
      reason: 'Bu haritaya erişim iznin yok.'
    }));
    ws.close(1008, 'World access denied');
    return;
  }

  const playerInfo = {
    id: playerId,
    name: playerName,
    color: playerColor,
    authenticated: Boolean(authenticatedUser),
    worldId: world ? world.id : null,
    cursor: { x: 0, z: 0 }
  };
  ws.playerInfo = playerInfo;
  if (world) world.players.set(ws, playerInfo);

  console.log(`[Online] ${playerName} ${world ? `"${world.name}" dünyasına` : 'ana sayfaya'} bağlandı. (${wss.clients.size} bağlantı)`);

  ws.send(JSON.stringify({
    type: 'INIT_STATE',
    playerId: playerId,
    playerInfo: playerInfo,
    ...(world ? {
      world: { id: world.id, name: world.name, mode: world.mode },
      seed: world.seed,
      resources: world.resources,
      harvestedEntities: world.harvestedEntities,
      buildings: world.buildings,
      colonistTargets: world.colonistTargets,
      players: Array.from(world.players.values())
    } : {}),
    chatHistory: recentChat.all(),
    ...(!world ? { players: connectedPlayers() } : {})
  }));

  if (world) {
    broadcastWorld(world, {
      type: 'PLAYER_JOINED',
      player: playerInfo,
      playerCount: world.players.size
    }, ws);
  }
  broadcastAll({ type: 'PLAYER_COUNT', playerCount: wss.clients.size });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      switch (data.type) {
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
          broadcastAll({ type: 'CHAT_MESSAGE', playerId, ...chatMessage });
          break;
      }

      if (data.type === 'CHAT_MESSAGE') return;
      if (!playerInfo.authenticated || !getSessionUser(req)) {
        ws.send(JSON.stringify({
          type: 'AUTH_REQUIRED',
          reason: 'Dünyada işlem yapmak için giriş yapmalısın.'
        }));
        return;
      }
      if (!world) {
        ws.send(JSON.stringify({
          type: 'ACTION_REJECTED',
          reason: 'Önce sunucudan bir harita seçmelisin.'
        }));
        return;
      }

      switch (data.type) {
        case 'CURSOR_MOVE':
          playerInfo.cursor = { x: data.x, z: data.z };
          broadcastWorld(world, {
            type: 'PLAYER_CURSOR',
            playerId,
            x: data.x,
            z: data.z
          }, ws);
          break;

        case 'COMMAND_COLONIST':
          world.colonistTargets[data.colonistId] = { x: data.targetX, z: data.targetZ, task: data.task };
          broadcastWorld(world, {
            type: 'COLONIST_MOVED',
            playerId,
            colonistId: data.colonistId,
            targetX: data.targetX,
            targetZ: data.targetZ,
            task: data.task
          });
          break;

        case 'HARVEST_RESOURCE':
          broadcastWorld(world, {
            type: 'HARVEST_STARTED',
            playerId,
            colonistId: data.colonistId,
            entityId: data.entityId,
            resType: data.resType
          });
          break;

        case 'HARVEST_COMPLETED':
          if (!world.harvestedEntities.includes(data.entityId)) {
            world.harvestedEntities.push(data.entityId);
            if (data.resType === 'wood') world.resources.wood += data.amount;
            else if (data.resType === 'stone') world.resources.stone += data.amount;
            else if (data.resType === 'food') world.resources.food += data.amount;

            saveWorldState(world);
            broadcastWorld(world, {
              type: 'RESOURCE_DEPLETED',
              entityId: data.entityId,
              resType: data.resType,
              amount: data.amount,
              resources: world.resources,
              harvesterName: playerInfo.name
            });
          }
          break;

        case 'PLACE_BUILDING':
          const building = {
            id: 'bld_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
            defId: data.defId,
            pos: data.pos,
            builderName: playerInfo.name
          };
          world.buildings.push(building);
          if (data.cost) {
            world.resources.wood -= (data.cost.wood || 0);
            world.resources.stone -= (data.cost.stone || 0);
          }
          saveWorldState(world);
          broadcastWorld(world, {
            type: 'BUILDING_PLACED',
            building: building,
            resources: world.resources
          });
          break;

        case 'NEW_MAP_REQUEST':
          ws.send(JSON.stringify({
            type: 'ACTION_REJECTED',
            reason: 'Harita oluşturma hakkını zaten kullandın.'
          }));
          break;
      }
    } catch (e) {
      console.error('Mesaj işleme hatası:', e);
    }
  });

  ws.on('close', () => {
    if (world) {
      world.players.delete(ws);
      broadcastWorld(world, {
        type: 'PLAYER_LEFT',
        playerId,
        playerCount: world.players.size
      });
    }
    broadcastAll({ type: 'PLAYER_COUNT', playerCount: wss.clients.size });
    console.log(`[Online] ${playerName} bağlantısı kapandı. (${wss.clients.size} bağlantı)`);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Aethelgard 3D sunucusu ${HOST}:${PORT} üzerinde aktif. SQLite: ${DATABASE_PATH}`);
});
