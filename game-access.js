const accessTitle = document.getElementById('access-title');
const accessDescription = document.getElementById('access-description');
const accountLink = document.getElementById('access-account-link');
const accessAction = document.getElementById('access-action');
const accessError = document.getElementById('access-error');
const accessGate = document.getElementById('game-access');

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

async function loadAccessState() {
  try {
    const userResult = await readJsonResponse(await fetch('/api/me'));
    if (!userResult.user) {
      accessTitle.textContent = 'Dünyaya girmek için hesap gerekli';
      accessDescription.textContent = 'Haritaya erişmek için önce ücretsiz hesap oluştur veya hesabına giriş yap.';
      accountLink.hidden = false;
      accountLink.onclick = () => sessionStorage.setItem('aethelgard-return-to-game', 'true');
      return;
    }

    const world = await readJsonResponse(await fetch('/api/world'));
    accessTitle.textContent = world.exists ? 'Ortak dünya seni bekliyor' : 'Yeni bir dünya kur';
    accessDescription.textContent = world.exists
      ? `Hoş geldin, ${userResult.user.username}. Aynı dünyaya katıl ve kolonini geliştir.`
      : `Hoş geldin, ${userResult.user.username}. İlk haritayı oluşturup ortak dünyayı başlat.`;
    accessAction.textContent = world.exists ? 'Dünyaya katıl' : 'Harita oluştur';
    accessAction.hidden = false;
    accessAction.onclick = async () => {
      accessAction.disabled = true;
      accessError.textContent = '';
      try {
        if (!world.exists) {
          await readJsonResponse(await fetch('/api/world/create', { method: 'POST' }));
        }
        accessGate.hidden = true;
        document.getElementById('game-container').hidden = false;
        document.getElementById('ui-layer').hidden = false;
        await import('./main.js');
      } catch (error) {
        accessError.textContent = `${error.message} Sayfayı yenileyip tekrar dene.`;
        accessAction.disabled = false;
        accessGate.hidden = false;
        document.getElementById('game-container').hidden = true;
        document.getElementById('ui-layer').hidden = true;
      }
    };
  } catch (error) {
    accessTitle.textContent = 'Sunucuya bağlanılamadı';
    accessDescription.textContent = 'Hesap ve dünya bilgisi şu anda alınamıyor.';
    accessError.textContent = error.message;
  }
}

loadAccessState();
