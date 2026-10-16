const accessTitle = document.getElementById('access-title');
const accessDescription = document.getElementById('access-description');
const accountLink = document.getElementById('access-account-link');
const accessError = document.getElementById('access-error');
const accessGate = document.getElementById('game-access');
const serverList = document.getElementById('server-list');
const worldLobby = document.getElementById('world-lobby');
const worldList = document.getElementById('world-list');
const worldListEmpty = document.getElementById('world-list-empty');
const createWorldButton = document.getElementById('show-create-world');
const createWorldForm = document.getElementById('create-world-form');
const createWorldSubmit = document.getElementById('create-world-submit');

async function readJsonResponse(response) {
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Sunucu geçerli yanıt vermedi (HTTP ${response.status}).`);
  }
  if (!response.ok) throw new Error(body.error || `İstek başarısız oldu (HTTP ${response.status}).`);
  return body;
}

function startWorld(worldId) {
  window.location.assign(`/game.html?world=${encodeURIComponent(worldId)}`);
}

function addWorldCard(world, currentUsername) {
  const card = document.createElement('article');
  card.className = 'world-card';

  const details = document.createElement('div');
  details.className = 'world-card-details';
  const name = document.createElement('strong');
  name.textContent = world.name;
  const meta = document.createElement('span');
  const isOwner = world.owner && world.owner.toLowerCase() === currentUsername.toLowerCase();
  meta.textContent = `${world.mode === 'shared' ? 'Ortak harita' : 'Tek kişilik'} · ${world.players} çevrimiçi${isOwner ? ' · Senin haritan' : ''}`;
  details.append(name, meta);

  const join = document.createElement('button');
  join.className = 'game-access-secondary';
  join.type = 'button';
  join.textContent = world.mode === 'solo' ? 'Haritama dön' : 'Katıl';
  join.addEventListener('click', () => startWorld(world.id));

  card.append(details, join);
  worldList.appendChild(card);
}

async function loadAccessState() {
  try {
    const userResult = await readJsonResponse(await fetch('/api/me'));
    if (!userResult.user) {
      accessTitle.textContent = 'Dünyalara katılmak için hesap gerekli';
      accessDescription.textContent = 'Sunucudaki haritaları görmek veya kendi haritanı oluşturmak için hesabına giriş yap.';
      accountLink.hidden = false;
      accountLink.onclick = () => sessionStorage.setItem('aethelgard-return-to-game', 'true');
      return;
    }

    const [serverResult, worldResult] = await Promise.all([
      readJsonResponse(await fetch('/api/servers')),
      readJsonResponse(await fetch('/api/worlds'))
    ]);
    const server = serverResult.servers[0];
    serverList.replaceChildren();
    const serverCard = document.createElement('div');
    serverCard.className = 'server-card';
    const serverName = document.createElement('strong');
    serverName.textContent = server.name;
    const serverMeta = document.createElement('span');
    serverMeta.textContent = `Çevrimiçi · ${server.worlds} harita`;
    serverCard.append(serverName, serverMeta);
    serverList.appendChild(serverCard);
    serverList.hidden = false;

    const requestedWorldId = new URLSearchParams(window.location.search).get('world');
    if (requestedWorldId) {
      const requestedWorld = worldResult.worlds.find(world => world.id === requestedWorldId);
      if (requestedWorld) {
        accessTitle.textContent = requestedWorld.name;
        accessDescription.textContent = 'Harita yükleniyor...';
        accessGate.hidden = true;
        document.getElementById('game-container').hidden = false;
        document.getElementById('ui-layer').hidden = false;
        await import('./main.js');
        return;
      }
      accessError.textContent = 'Bu harita bulunamadı veya erişim iznin yok. Harita listesinden başka bir dünya seç.';
    }

    accessTitle.textContent = `Sunucular · ${server.name}`;
    accessDescription.textContent = `Hoş geldin, ${userResult.user.username}. Bir haritaya katıl veya sana ait tek harita oluşturma hakkını kullan.`;
    worldLobby.hidden = false;
    worldList.replaceChildren();
    worldResult.worlds.forEach(world => addWorldCard(world, userResult.user.username));
    worldListEmpty.hidden = worldResult.worlds.length > 0;

    const canCreateWorld = !worldResult.ownedWorldId;
    createWorldButton.hidden = !canCreateWorld;
    document.getElementById('map-creation-status').textContent = canCreateWorld
      ? 'Hesap başına bir harita oluşturabilirsin.'
      : 'Harita oluşturma hakkını kullandın.';
    document.getElementById('world-name').value = `${userResult.user.username} Dünyası`;
    createWorldButton.addEventListener('click', () => {
      createWorldForm.hidden = !createWorldForm.hidden;
      if (!createWorldForm.hidden) document.getElementById('world-name').focus();
    });

    createWorldForm.addEventListener('submit', async event => {
      event.preventDefault();
      createWorldSubmit.disabled = true;
      accessError.textContent = '';
      try {
        const response = await fetch('/api/worlds', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: document.getElementById('world-name').value,
            mode: createWorldForm.elements.mode.value
          })
        });
        const result = await readJsonResponse(response);
        startWorld(result.world.id);
      } catch (error) {
        accessError.textContent = error.message;
        createWorldSubmit.disabled = false;
      }
    });
  } catch (error) {
    accessTitle.textContent = 'Sunucuya bağlanılamadı';
    accessDescription.textContent = 'Hesap ve sunucu bilgisi şu anda alınamıyor.';
    accessError.textContent = error.message;
  }
}

loadAccessState();
