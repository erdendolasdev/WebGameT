const authModal = document.getElementById('auth-modal');
const authForm = document.getElementById('auth-form');
const authFeedback = document.getElementById('auth-feedback');
const chatFeed = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const chatHint = document.getElementById('chat-hint');
const chatConnection = document.getElementById('chat-connection');
const onlineCount = document.getElementById('online-count');
const playButton = document.getElementById('play-button');
let authMode = 'register';
let currentUser = null;
let socket = null;
let reconnectTimer = null;
let onlinePlayers = 0;
const pendingChatMessages = [];

function continueToGameIfRequested() {
  if (currentUser && sessionStorage.getItem('aethelgard-return-to-game') === 'true') {
    sessionStorage.removeItem('aethelgard-return-to-game');
    window.location.assign('/game.html');
    return true;
  }
  return false;
}

function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === 'register';
  document.getElementById('auth-title').textContent = registering ? 'Yeni bir hikâye başlat.' : 'Yeniden hoş geldin.';
  document.getElementById('auth-description').textContent = registering
    ? 'Ücretsiz hesabını oluştur, kolonin seni bekliyor.'
    : 'Kolonine dönmek için hesabına giriş yap.';
  document.getElementById('auth-submit').innerHTML = registering
    ? 'Hesabımı oluştur <span aria-hidden="true">↗</span>'
    : 'Giriş yap <span aria-hidden="true">↗</span>';
  document.getElementById('password').autocomplete = registering ? 'new-password' : 'current-password';
  document.querySelectorAll('[data-auth-tab]').forEach(tab => {
    const active = tab.dataset.authTab === mode;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  authFeedback.textContent = '';
  authFeedback.classList.remove('success');
}

function openAuth(mode = 'register') {
  setAuthMode(mode);
  authModal.hidden = false;
  document.getElementById('username').focus();
}

function closeAuth() {
  authModal.hidden = true;
  authFeedback.textContent = '';
}

function setCurrentUser(user) {
  const previousUsername = currentUser ? currentUser.username : null;
  currentUser = user;
  document.getElementById('account-actions').hidden = Boolean(user);
  document.getElementById('account-menu').hidden = !user;
  document.getElementById('account-name').textContent = user ? user.username : '';
  chatInput.disabled = !user;
  chatInput.placeholder = user ? 'Koloniye bir selam bırak...' : 'Sohbete katılmak için giriş yap';
  chatHint.textContent = user ? 'Dünyadaki herkes bu sohbeti görebilir.' : 'Sohbete katılmak için hesabınla giriş yap.';
  playButton.textContent = user ? 'Kolonime dön ↗' : 'Dünyaya katıl ↗';
  if (previousUsername !== (user ? user.username : null)) {
    pendingChatMessages.length = 0;
  }
  if (socket && socket.readyState === WebSocket.OPEN && previousUsername !== (user ? user.username : null)) {
    socket.close();
  }
}

function showSystemMessage(text) {
  appendChatMessage({ system: true, text });
}

function appendChatMessage(message) {
  const emptyMessage = document.getElementById('chat-empty');
  if (emptyMessage) emptyMessage.remove();
  const row = document.createElement('div');
  row.className = message.system ? 'chat-message system-message' : 'chat-message';
  if (message.time) {
    const time = document.createElement('time');
    time.textContent = `[${message.time}]`;
    row.appendChild(time);
  }
  if (message.playerName) {
    const author = document.createElement('strong');
    author.textContent = `${message.playerName}:`;
    if (message.playerColor) author.style.color = message.playerColor;
    row.appendChild(author);
  }
  const text = document.createElement('span');
  text.textContent = message.text || '';
  row.appendChild(text);
  chatFeed.appendChild(row);
  while (chatFeed.children.length > 40) chatFeed.firstElementChild.remove();
  chatFeed.scrollTop = chatFeed.scrollHeight;
}

async function loadCurrentUser() {
  try {
    const response = await fetch('/api/me');
    const result = await readApiResponse(response);
    setCurrentUser(result.user);
    continueToGameIfRequested();
  } catch (error) {
    console.error('[Account]', error);
    document.getElementById('world-status').textContent = 'Hesap servisine ulaşılamadı';
  }
}

async function readApiResponse(response) {
  const body = await response.text();
  if (!body.trim()) {
    throw new Error(response.ok
      ? 'Sunucu boş yanıt verdi. Biraz sonra tekrar dene.'
      : `Sunucu isteği tamamlayamadı (HTTP ${response.status}).`);
  }

  let result;
  try {
    result = JSON.parse(body);
  } catch {
    throw new Error(response.ok
      ? 'Sunucudan geçersiz yanıt geldi. Hosting/API ayarlarını kontrol et.'
      : `Sunucu hatası (HTTP ${response.status}).`);
  }
  if (!response.ok) throw new Error(result.error || `İstek başarısız oldu (HTTP ${response.status}).`);
  return result;
}

authForm.addEventListener('submit', async event => {
  event.preventDefault();
  const submitButton = document.getElementById('auth-submit');
  submitButton.disabled = true;
  authFeedback.textContent = '';
  try {
    const response = await fetch(`/api/${authMode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: document.getElementById('password').value
      })
    });
    const result = await readApiResponse(response);
    if (!result.user || typeof result.user.username !== 'string') {
      throw new Error('Sunucu hesap oluşturdu ancak oturum bilgisi dönmedi. Tekrar giriş yapmayı dene.');
    }
    setCurrentUser(result.user);
    if (continueToGameIfRequested()) return;
    closeAuth();
    showSystemMessage(`Hoş geldin, ${result.user.username}.`);
    document.getElementById('world-status').textContent = 'Aethelgard dünyası seni bekliyor';
  } catch (error) {
    if (error.name === 'TimeoutError') {
      authFeedback.textContent = 'Sunucu yanıt vermedi. Biraz sonra tekrar dene.';
    } else if (error instanceof TypeError) {
      authFeedback.textContent = 'Sunucuya ulaşılamadı. Hosting/API ayarlarını kontrol edip tekrar dene.';
    } else {
      authFeedback.textContent = error.message || 'İşlem tamamlanamadı. Tekrar dene.';
    }
  } finally {
    submitButton.disabled = false;
  }
});

document.querySelectorAll('[data-auth]').forEach(button => {
  button.addEventListener('click', () => openAuth(button.dataset.auth));
});
document.querySelectorAll('[data-auth-tab]').forEach(button => {
  button.addEventListener('click', () => setAuthMode(button.dataset.authTab));
});
document.getElementById('close-auth').addEventListener('click', closeAuth);
authModal.addEventListener('click', event => {
  if (event.target === authModal) closeAuth();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !authModal.hidden) closeAuth();
});

document.getElementById('logout-button').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/logout', { method: 'POST' });
    if (!response.ok) throw new Error('Çıkış yapılamadı.');
    setCurrentUser(null);
    showSystemMessage('Oturum kapatıldı.');
  } catch (error) {
    console.error('[Account]', error);
    showSystemMessage(error.message);
  }
});

playButton.addEventListener('click', event => {
  if (!currentUser) {
    event.preventDefault();
    openAuth('register');
  }
});

document.getElementById('chat-form').addEventListener('submit', event => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  if (!currentUser) {
    openAuth('login');
    return;
  }
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    if (pendingChatMessages.length < 10) {
      pendingChatMessages.push(text);
      chatInput.value = '';
      chatConnection.textContent = 'Mesaj bağlantı bekliyor';
      if (!socket || socket.readyState === WebSocket.CLOSED) connectChat();
    } else {
      chatConnection.textContent = 'Sohbet yoğun; biraz sonra tekrar dene';
    }
    return;
  }
  socket.send(JSON.stringify({ type: 'CHAT_MESSAGE', text }));
  chatInput.value = '';
});

function connectChat() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${window.location.host}`);
  const connectionUser = currentUser ? currentUser.username : null;
  socket.addEventListener('open', () => {
    const activeUsername = currentUser ? currentUser.username : null;
    if (connectionUser !== activeUsername) {
      socket.close();
      return;
    }
    chatConnection.textContent = 'Canlı sohbet';
    document.getElementById('world-status').textContent = 'Aethelgard dünyası çevrimiçi';
    if (currentUser && pendingChatMessages.length) {
      pendingChatMessages.splice(0).forEach(text => {
        socket.send(JSON.stringify({ type: 'CHAT_MESSAGE', text }));
      });
    }
  });
  socket.addEventListener('message', event => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      console.error('[Chat] Sunucu mesajı okunamadı:', error);
      return;
    }

    if (message.type === 'INIT_STATE') {
      onlinePlayers = message.players ? message.players.length : 1;
      chatFeed.replaceChildren();
      (message.chatHistory || []).forEach(appendChatMessage);
      if (!chatFeed.childElementCount) {
        const emptyMessage = document.createElement('p');
        emptyMessage.className = 'chat-empty';
        emptyMessage.id = 'chat-empty';
        emptyMessage.textContent = 'Dünyadan ilk haberi bekliyoruz...';
        chatFeed.appendChild(emptyMessage);
      }
      onlineCount.textContent = String(onlinePlayers);
      return;
    }
    if (message.type === 'PLAYER_JOINED') {
      onlinePlayers = message.playerCount || onlinePlayers + 1;
      onlineCount.textContent = String(onlinePlayers);
      return;
    }
    if (message.type === 'PLAYER_LEFT') {
      onlinePlayers = message.playerCount || Math.max(0, onlinePlayers - 1);
      onlineCount.textContent = String(onlinePlayers);
      return;
    }
    if (message.type === 'PLAYER_COUNT') {
      onlinePlayers = message.playerCount;
      onlineCount.textContent = String(onlinePlayers);
      return;
    }
    if (message.type === 'CHAT_MESSAGE') {
      appendChatMessage(message);
      return;
    }
    if (message.type === 'CHAT_REJECTED') showSystemMessage(message.reason);
  });
  socket.addEventListener('close', () => {
    chatConnection.textContent = 'Yeniden bağlanıyor';
    reconnectTimer = window.setTimeout(connectChat, 3000);
  });
  socket.addEventListener('error', () => {
    chatConnection.textContent = 'Bağlantı kurulamadı';
  });
}

loadCurrentUser();
connectChat();

const requestedAuthMode = new URLSearchParams(window.location.search).get('auth');
if (requestedAuthMode === 'register' || requestedAuthMode === 'login') openAuth(requestedAuthMode);
