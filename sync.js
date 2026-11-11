/* Lume — sincronização com o Google Drive do próprio usuário.
   - Dados: arquivo "lume-data.json" na pasta oculta do app (appDataFolder), visível só para o Lume.
   - Backups: 1 arquivo por dia na pasta "Lume - Backups" do seu Drive (visível para você).
   - Mesclagem por registro: cada item tem _u (hora da última alteração); exclusões ficam em _del. */
(function () {
  'use strict';
  const LS_CLIENT = 'lume-google-client-id';
  const LS_TOKEN = 'lume-google-token';
  const LS_LAST = 'lume-last-sync';
  const LS_DIRTY = 'lume-sync-dirty';
  const LS_BACKUP_DAY = 'lume-last-drive-backup';
  const SCOPES = 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file';
  const DATA_NAME = 'lume-data.json';
  const BACKUP_FOLDER = 'Lume - Backups';
  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
    del(k) { try { localStorage.removeItem(k); } catch (_) {} },
  };
  let tokenClient = null, gisPromise = null, syncing = false, timer = null, status = '', statusKind = 'idle', applyingRemote = false;

  const app = () => window.LumeApp;
  const clientId = () => (ls.get(LS_CLIENT) || '').trim();
  const configured = () => !!clientId();
  function token() {
    try { const t = JSON.parse(ls.get(LS_TOKEN) || 'null'); if (t && t.access_token && t.expires_at > Date.now() + 60000) return t.access_token; } catch (_) {}
    return null;
  }
  const connected = () => !!ls.get(LS_TOKEN);
  const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

  function setStatus(text, kind) { status = text; statusKind = kind || 'idle'; paintPill(); paintPanel(); }

  // ---------- Login Google (Google Identity Services) ----------
  function loadGis() {
    if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
    if (gisPromise) return gisPromise;
    gisPromise = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = () => res(); s.onerror = () => { gisPromise = null; rej(Error('Sem internet ou o login do Google foi bloqueado.')); };
      document.head.appendChild(s);
    });
    return gisPromise;
  }
  async function requestToken(interactive) {
    if (!configured()) throw Error('Informe o ID do cliente Google em Ajustes.');
    await loadGis();
    return new Promise((resolve, reject) => {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId(), scope: SCOPES,
        callback: (r) => {
          if (r.error) { reject(Error(r.error_description || r.error)); return; }
          ls.set(LS_TOKEN, JSON.stringify({ access_token: r.access_token, expires_at: Date.now() + (Number(r.expires_in) || 3600) * 1000 }));
          resolve(r.access_token);
        },
        error_callback: (e) => reject(Error(e && e.type === 'popup_closed' ? 'Janela de login fechada.' : (e && e.message) || 'Falha no login do Google.')),
      });
      tokenClient.requestAccessToken({ prompt: interactive === 'consent' ? 'consent' : '' });
    });
  }

  // ---------- Drive ----------
  async function drive(url, opts, tk) {
    const r = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + tk, ...(opts && opts.headers) } });
    if (r.status === 401) { ls.set(LS_TOKEN, JSON.stringify({ access_token: '', expires_at: 0 })); throw Object.assign(Error('Sessão do Google expirou.'), { auth: true }); }
    if (!r.ok) { let m = ''; try { m = (await r.json()).error.message; } catch (_) {} throw Error(`Google Drive respondeu ${r.status}${m ? ': ' + m : ''}`); }
    return r;
  }
  async function findFile(tk, q, spaces) {
    const u = `${API}/files?spaces=${spaces}&fields=files(id,name,modifiedTime)&pageSize=10&q=${encodeURIComponent(q)}`;
    const j = await (await drive(u, {}, tk)).json();
    return (j.files || [])[0] || null;
  }
  async function createFile(tk, meta, body, mime) {
    const boundary = 'lume' + Math.random().toString(36).slice(2);
    const payload = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n${body}\r\n--${boundary}--`;
    const r = await drive(`${UPLOAD}/files?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body: payload }, tk);
    return (await r.json()).id;
  }
  async function updateFile(tk, id, body) {
    await drive(`${UPLOAD}/files/${id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body }, tk);
  }

  // ---------- Mesclagem ----------
  function merge(a, b) {
    const out = { ...b, ...a };
    const del = { ...(b._del || {}) };
    for (const [k, t] of Object.entries(a._del || {})) del[k] = Math.max(del[k] || 0, t);
    const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter(k => Array.isArray(a[k]) || Array.isArray(b[k])));
    for (const k of keys) {
      const map = new Map();
      for (const x of (Array.isArray(a[k]) ? a[k] : [])) if (x && x.id) map.set(x.id, x);
      for (const x of (Array.isArray(b[k]) ? b[k] : [])) {
        if (!x || !x.id) continue;
        const y = map.get(x.id);
        if (!y || (x._u || 0) > (y._u || 0)) map.set(x.id, x);
      }
      out[k] = [...map.values()].filter(x => !(del[k + ':' + x.id] >= (x._u || 0)));
    }
    // limpa exclusões com mais de 1 ano
    const limit = Date.now() - 365 * 864e5;
    for (const k of Object.keys(del)) if (del[k] < limit) delete del[k];
    out._del = del;
    out.version = a.version || b.version;
    delete out.exportedAt;
    return out;
  }
  const strip = (s) => { const c = { ...s }; delete c.exportedAt; return JSON.stringify(c); };

  // ---------- Sincronização ----------
  async function syncNow(interactive) {
    if (syncing || !configured() || !app()) return;
    if (!navigator.onLine) { setStatus('Sem internet — sincroniza quando voltar', 'wait'); return; }
    let tk = token();
    if (!tk) {
      if (!interactive) { setStatus('Toque para sincronizar', 'wait'); return; }
      try { tk = await requestToken(connected() ? '' : 'consent'); } catch (e) { setStatus(e.message, 'bad'); return; }
    }
    syncing = true; setStatus('Sincronizando…', 'busy');
    try {
      const local = app().getState();
      const file = await findFile(tk, `name='${DATA_NAME}' and trashed=false`, 'appDataFolder');
      let merged = local, remoteText = null;
      if (file) {
        remoteText = await (await drive(`${API}/files/${file.id}?alt=media`, {}, tk)).text();
        let remote = null; try { remote = JSON.parse(remoteText); } catch (_) {}
        if (remote && remote.version === local.version) merged = merge(local, remote);
      }
      const mergedText = strip(merged);
      if (mergedText !== strip(local)) { applyingRemote = true; app().replaceState(merged); applyingRemote = false; }
      if (!file) await createFile(tk, { name: DATA_NAME, parents: ['appDataFolder'] }, mergedText, 'application/json');
      else if (mergedText !== remoteText) await updateFile(tk, file.id, mergedText);
      ls.del(LS_DIRTY); ls.set(LS_LAST, String(Date.now()));
      await dailyBackup(tk, merged).catch(e => console.warn('Backup diário', e));
      setStatus('Sincronizado', 'good');
    } catch (e) {
      console.warn('Sync', e);
      setStatus(e.auth ? 'Toque para entrar no Google' : 'Erro: ' + e.message, e.auth ? 'wait' : 'bad');
    } finally { syncing = false; applyingRemote = false; }
  }
  async function dailyBackup(tk, data) {
    const day = localToday();
    if (ls.get(LS_BACKUP_DAY) === day) return;
    let folder = await findFile(tk, `name='${BACKUP_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`, 'drive');
    const folderId = folder ? folder.id : await createFile(tk, { name: BACKUP_FOLDER, mimeType: 'application/vnd.google-apps.folder' }, '', 'text/plain');
    const name = `lume-backup-${day}.json`;
    const text = JSON.stringify({ ...data, exportedAt: new Date().toISOString() }, null, 2);
    const existing = await findFile(tk, `name='${name}' and '${folderId}' in parents and trashed=false`, 'drive');
    if (existing) await updateFile(tk, existing.id, text);
    else await createFile(tk, { name, parents: [folderId] }, text, 'application/json');
    ls.set(LS_BACKUP_DAY, day);
  }

  function changed() {
    if (applyingRemote || !configured()) return;
    ls.set(LS_DIRTY, '1');
    clearTimeout(timer);
    timer = setTimeout(() => syncNow(false), 2500);
    paintPill();
  }

  // ---------- Interface ----------
  function ago(ms) { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'agora' : m < 60 ? `há ${m} min` : m < 1440 ? `há ${Math.round(m / 60)} h` : `há ${Math.round(m / 1440)} dia(s)`; }
  function paintPill() {
    const el = document.getElementById('syncPill'); if (!el) return;
    if (!configured()) { el.style.display = 'none'; return; }
    const dirty = !!ls.get(LS_DIRTY);
    let text = status || (token() ? (dirty ? 'Alterações pendentes' : 'Sincronizado') : 'Toque para sincronizar');
    let kind = statusKind; if (!status) kind = token() ? (dirty ? 'wait' : 'good') : 'wait';
    el.style.display = 'flex'; el.dataset.kind = kind;
    el.innerHTML = `<span class="dot"></span><span>${app().esc(text)}</span>`;
    el.title = 'Sincronização com o Google Drive' + (ls.get(LS_LAST) ? ' · última: ' + ago(Number(ls.get(LS_LAST))) : '');
  }
  function paintPanel() {
    const box = document.getElementById('syncPanel'); if (!box || !app()) return;
    const esc = app().esc, last = ls.get(LS_LAST);
    box.innerHTML = `<section class="panel" style="margin-bottom:17px"><div class="panel-head"><h2>☁ Sincronização com o Google Drive</h2><span class="tag ${statusKind === 'good' ? 'good' : statusKind === 'bad' ? 'bad' : 'wait'}">${esc(status || (configured() ? (connected() ? 'Conectado' : 'Não conectado') : 'Desativada'))}</span></div>
      <p class="muted">Os mesmos dados no celular e no computador. Ficam numa área privada do Lume no <b>seu</b> Google Drive, e todo dia é salvo um backup JSON na pasta <b>${BACKUP_FOLDER}</b>.</p>
      <div class="fields" style="margin-top:10px"><div class="field full"><label for="syncClient">ID do cliente Google (OAuth)</label><input id="syncClient" placeholder="123456-abc.apps.googleusercontent.com" value="${esc(clientId())}" autocomplete="off" spellcheck="false"><div class="help">Criado uma única vez no Google Cloud (veja o guia). Precisa ser igual nos dois aparelhos.</div></div></div>
      <div class="block-actions" style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" class="btn primary" id="syncConnect">${connected() ? '⟳ Sincronizar agora' : 'Conectar ao Google Drive'}</button>
        ${connected() ? '<button type="button" class="btn" id="syncOff">Desconectar</button>' : ''}
      </div>
      <div class="sentinel" style="margin-top:10px">${last ? 'Última sincronização: ' + ago(Number(last)) + '.' : 'Ainda não sincronizado.'} No celular, o Google pede para confirmar o acesso cerca de 1 vez por hora de uso — basta tocar no aviso “Toque para sincronizar”.</div></section>`;
    const inp = document.getElementById('syncClient');
    inp.addEventListener('change', () => { const v = inp.value.trim(); if (v && !/\.apps\.googleusercontent\.com$/.test(v)) { alert('O ID do cliente termina com ".apps.googleusercontent.com". Confira se copiou o ID certo (não a chave secreta).'); return; } ls.set(LS_CLIENT, v); ls.del(LS_TOKEN); setStatus('', 'idle'); });
    document.getElementById('syncConnect').addEventListener('click', () => { const v = inp.value.trim(); if (v !== clientId()) { ls.set(LS_CLIENT, v); ls.del(LS_TOKEN); } if (!configured()) { alert('Cole primeiro o ID do cliente Google.'); return; } syncNow(true); });
    const off = document.getElementById('syncOff');
    if (off) off.addEventListener('click', () => { if (!confirm('Desconectar deste aparelho? Os dados continuam aqui e no Drive.')) return; const t = token(); if (t && window.google && google.accounts) try { google.accounts.oauth2.revoke(t, () => {}); } catch (_) {} ls.del(LS_TOKEN); setStatus('', 'idle'); paintPanel(); });
  }
  function afterRender(view) { paintPill(); if (view === 'settings') paintPanel(); }

  const css = document.createElement('style');
  css.textContent = `#syncPill{position:fixed;top:calc(10px + env(safe-area-inset-top));right:12px;z-index:40;display:none;align-items:center;gap:7px;padding:6px 11px;border-radius:999px;font:600 12px/1.2 system-ui,sans-serif;background:#1a2a42;color:#dbe7f7;border:1px solid #2a3c58;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.3)}#syncPill .dot{width:8px;height:8px;border-radius:50%;background:#9baac1}#syncPill[data-kind=good] .dot{background:#4bdfaa}#syncPill[data-kind=wait] .dot{background:#ffd48b}#syncPill[data-kind=bad] .dot{background:#ff8992}#syncPill[data-kind=busy] .dot{background:#91b8ff;animation:lumepulse 1s infinite}@keyframes lumepulse{50%{opacity:.3}}@media(max-width:700px){#syncPill{top:calc(8px + env(safe-area-inset-top));right:8px;padding:5px 9px;font-size:11px}}`;
  document.head.appendChild(css);
  document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('#syncPill')) syncNow(true); });
  window.addEventListener('online', () => syncNow(false));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(false); });
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(false); }, 3 * 60000);

  window.LumeSync = { changed, afterRender, syncNow, merge };
  const start = () => { paintPill(); if (configured()) syncNow(false); };
  if (document.readyState === 'complete') setTimeout(start, 300); else window.addEventListener('load', () => setTimeout(start, 300));
})();
