// ============================================================================
// BaixaAiRESOLVE — painel para DaVinci Resolve
// Port do BaixaAiPRO (Premiere) usando a API de scripting do Resolve via bridge.
// ============================================================================
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Estado global / plataforma
// ---------------------------------------------------------------------------
let PATHS = null;
let IS_MAC = false;
let SEP = '\\';
let EXE_EXT = '.exe';

let downloadsDir = '';
let taskQueue = [];
let isProcessingQueue = false;
let currentActiveTask = null;
let ultimosDisparosMap = {};
let isRecListening = false;
let lastRecMatch = null;
let currentPreviewUrl = '';
let recHistory = [];
let statusPollTimer = null;
let hasTimeline = false;

const REC_HIST_KEY = 'baixaai_resolve_shazam_history_v1';

// ---------------------------------------------------------------------------
// Elementos da interface
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

const tabsNav = $('tabsNav');
const tabBtnDownload = $('tabBtnDownload');
const tabBtnRecognize = $('tabBtnRecognize');
const paneDownload = $('paneDownload');
const paneRecognize = $('paneRecognize');
const queueCountPill = $('queueCountPill');

const urlInput = $('urlInput');
const qualitySelect = $('qualitySelect');
const qualityHint = $('qualityHint');
const playlistNotice = $('playlistNotice');
const spotifyNotice = $('spotifyNotice');
const destPathEl = $('destPath');
const btnClear = $('btnClear');
const btnStart = $('btnStart');
const queueList = $('queueList');
let queueEmpty = $('queueEmpty');

const recSeqName = $('recSeqName');
const recPlayhead = $('recPlayhead');
const recStage = $('recStage');
const btnRecListen = $('btnRecListen');
const recOrbText = $('recOrbText');
const recStageTitle = $('recStageTitle');
const recStageSub = $('recStageSub');
const recError = $('recError');

const recMatchShowcase = $('recMatchShowcase');
const recResCover = $('recResCover');
const btnRecPreview = $('btnRecPreview');
const recResClip = $('recResClip');
const recResTitle = $('recResTitle');
const recResArtist = $('recResArtist');
const recResMeta = $('recResMeta');
const recAutoDlStatus = $('recAutoDlStatus');

const recHistoryList = $('recHistoryList');
const btnClearRecHist = $('btnClearRecHist');
const audioPreviewPlayer = $('audioPreviewPlayer');

// ---------------------------------------------------------------------------
// Utilitarios
// ---------------------------------------------------------------------------
function gerarSufixoAleatorio() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let r = '';
  for (let i = 0; i < 4; i++) r += chars.charAt(Math.floor(Math.random() * chars.length));
  return r;
}

function copiarParaClipboard(texto) {
  if (!texto) return false;
  try {
    const el = document.createElement('textarea');
    el.value = texto;
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.focus();
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    if (ok) return true;
  } catch (_) {}
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(texto);
      return true;
    }
  } catch (_) {}
  return false;
}

// ---------------------------------------------------------------------------
// Abas
// ---------------------------------------------------------------------------
function alternarAba(aba) {
  if (aba === 'recognize') {
    tabsNav.classList.add('recognize-active');
    tabBtnRecognize.classList.add('active');
    tabBtnDownload.classList.remove('active');
    paneRecognize.classList.add('active');
    paneDownload.classList.remove('active');
    atualizarStatusSequencia();
  } else {
    tabsNav.classList.remove('recognize-active');
    tabBtnDownload.classList.add('active');
    tabBtnRecognize.classList.remove('active');
    paneDownload.classList.add('active');
    paneRecognize.classList.remove('active');
  }
}

tabBtnDownload.addEventListener('click', () => alternarAba('download'));
tabBtnRecognize.addEventListener('click', () => alternarAba('recognize'));

function atualizarContadorFila() {
  const total = taskQueue.length + (isProcessingQueue ? 1 : 0);
  if (total > 0) {
    queueCountPill.innerText = String(total);
    queueCountPill.style.display = 'inline-block';
  } else {
    queueCountPill.style.display = 'none';
  }
}

// ---------------------------------------------------------------------------
// Inicializacao
// ---------------------------------------------------------------------------
async function inicializarPainel() {
  PATHS = await window.api.getPaths();
  IS_MAC = PATHS.platform === 'darwin';
  SEP = IS_MAC ? '/' : '\\';
  EXE_EXT = IS_MAC ? '' : '.exe';
  downloadsDir = PATHS.downloadsDir;

  carregarHistoricoReconhecimento();
  montarBotaoAlterarPasta();
  atualizarPastaDownload();
  atualizarAvisoQualidade();
  atualizarStatusSequencia();
}

function montarBotaoAlterarPasta() {
  if (!destPathEl || $('btnChooseFolder')) return;
  const btn = document.createElement('button');
  btn.id = 'btnChooseFolder';
  btn.innerText = '\uD83D\uDCC1 Alterar';
  btn.style.cssText =
    'margin-left:8px;background:#1f1f26;color:#9ca3af;border:1px solid #2a2a33;border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer;';
  btn.addEventListener('click', async () => {
    const dir = await window.api.chooseFolder();
    if (dir) {
      downloadsDir = await window.api.setDownloadsDir(dir);
      atualizarPastaDownload();
    }
  });
  destPathEl.parentNode.insertBefore(btn, destPathEl.nextSibling);
}

function atualizarPastaDownload() {
  if (!destPathEl) return;
  destPathEl.innerText = 'Salvo em: ' + downloadsDir + ' (Abrir Pasta)';
  destPathEl.title = 'Clique para abrir a pasta de download';
  destPathEl.style.color = '#2979ff';
  destPathEl.style.cursor = 'pointer';
}

destPathEl.addEventListener('click', () => {
  window.api.openFolder(downloadsDir);
});

async function atualizarStatusSequencia() {
  recSeqName.innerText = 'Áudio do computador';
  recPlayhead.innerText = 'ao vivo';
  hasTimeline = true;
}

// ---------------------------------------------------------------------------
// ABA 1: DOWNLOADER + SPOTIFY
// ---------------------------------------------------------------------------
function atualizarVisualFormato() {
  document.querySelectorAll('input[name="format"]').forEach((r) => {
    const lbl = r.parentElement;
    if (lbl) {
      if (r.checked) lbl.classList.add('active-fmt');
      else lbl.classList.remove('active-fmt');
    }
  });
}

document.querySelectorAll('input[name="format"]').forEach((radio) => {
  radio.addEventListener('change', (e) => {
    const isAudio = e.target.value === 'audio';
    qualitySelect.disabled = isAudio;
    atualizarVisualFormato();
    atualizarAvisoQualidade();
  });
});

function selecionarModoAudio() {
  const radAudio = document.querySelector('input[name="format"][value="audio"]');
  if (radAudio) {
    radAudio.checked = true;
    qualitySelect.disabled = true;
    atualizarVisualFormato();
    atualizarAvisoQualidade();
  }
}

function atualizarAvisoQualidade() {
  const radChecked = document.querySelector('input[name="format"]:checked');
  const isAudio = radChecked && radChecked.value === 'audio';
  const val = qualitySelect.value;
  if (!isAudio && (val === '2160' || val === '1440' || val === 'best')) {
    if (qualityHint) qualityHint.style.display = 'block';
  } else if (qualityHint) {
    qualityHint.style.display = 'none';
  }
}

qualitySelect.addEventListener('change', atualizarAvisoQualidade);

function isLinkSpotify(url) {
  return !!url && url.toLowerCase().indexOf('spotify.com/') !== -1;
}

function extrairIdYouTube(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host.indexOf('youtube.com') !== -1) {
      if (u.pathname.indexOf('/shorts/') !== -1) {
        const parts = u.pathname.split('/shorts/');
        if (parts[1]) return parts[1].split('/')[0].split('?')[0];
      }
      return u.searchParams.get('v');
    }
    if (host.indexOf('youtu.be') !== -1) return u.pathname.replace('/', '');
  } catch (_) {}
  return null;
}

function sanitizarLink(rawUrl) {
  if (isLinkSpotify(rawUrl)) return rawUrl.split('?')[0];
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();
    if (host.indexOf('youtube.com') !== -1 || host.indexOf('youtu.be') !== -1) {
      if (u.pathname.indexOf('/shorts/') !== -1) return u.origin + u.pathname;
      const v = u.searchParams.get('v') || (host.indexOf('youtu.be') !== -1 ? u.pathname.replace('/', '') : null);
      if (v) return 'https://www.youtube.com/watch?v=' + v;
    }
    if (host.indexOf('instagram.com') !== -1 || host.indexOf('tiktok.com') !== -1) {
      return u.origin + u.pathname;
    }
    if (host.indexOf('vimeo.com') !== -1) {
      const h = u.searchParams.get('h');
      if (h) return u.origin + u.pathname + '?h=' + h;
      return u.origin + u.pathname;
    }
  } catch (e) {
    if (rawUrl.indexOf('list=') !== -1 && rawUrl.indexOf('&') !== -1) return rawUrl.split('&')[0];
  }
  return rawUrl;
}

function processarEntradaLink(val) {
  if (!val) {
    if (playlistNotice) playlistNotice.style.display = 'none';
    if (spotifyNotice) spotifyNotice.style.display = 'none';
    return;
  }
  if (isLinkSpotify(val)) {
    if (playlistNotice) playlistNotice.style.display = 'none';
    if (spotifyNotice) spotifyNotice.style.display = 'block';
    selecionarModoAudio();
    return;
  } else if (spotifyNotice) {
    spotifyNotice.style.display = 'none';
  }
  if (val.indexOf('list=') !== -1 && val.indexOf('&') !== -1) {
    urlInput.value = sanitizarLink(val);
    if (playlistNotice) {
      playlistNotice.style.display = 'block';
      setTimeout(() => { playlistNotice.style.display = 'none'; }, 5000);
    }
  } else if (playlistNotice) {
    playlistNotice.style.display = 'none';
  }
  if (val.indexOf('music.youtube.com') !== -1) selecionarModoAudio();
}

urlInput.addEventListener('paste', () => {
  setTimeout(() => processarEntradaLink(urlInput.value.trim()), 50);
});
urlInput.addEventListener('input', (e) => processarEntradaLink(e.target.value.trim()));

btnClear.addEventListener('click', () => {
  queueList.innerHTML = '<div id="queueEmpty" class="queue-empty">Sua fila est\u00e1 vazia. Cole um link acima ou use a aba <b>RECONHECER M\u00daSICA</b>!</div>';
  queueEmpty = $('queueEmpty');
  taskQueue = [];
  ultimosDisparosMap = {};
  atualizarContadorFila();
});

function removerAvisoFilaVazia() {
  const e = $('queueEmpty');
  if (e) e.remove();
}

function obterInfoBadgeFonte(url, isAudio, origemHint) {
  const u = (url || '').toLowerCase();
  const orig = (origemHint || '').toLowerCase();
  if (orig === 'spotify' || u.indexOf('spotify.com') !== -1) return { css: 'spotify', label: 'SPOTIFY', fallback: 'SPOTIFY' };
  if (orig === 'ytmusic' || orig === 'timeline' || u.indexOf('music.youtube.com') !== -1) return { css: 'ytmusic', label: 'YT MUSIC', fallback: 'MP3' };
  if (u.indexOf('vimeo.com') !== -1) return { css: 'vimeo', label: 'VIMEO', fallback: 'VIMEO' };
  if (u.indexOf('/shorts/') !== -1) return { css: 'shorts', label: 'SHORTS', fallback: 'SHORTS' };
  if (u.indexOf('instagram.com') !== -1) return { css: 'reels', label: 'REELS', fallback: 'REELS' };
  if (u.indexOf('tiktok.com') !== -1) return { css: 'tiktok', label: 'TIKTOK', fallback: 'TIKTOK' };
  if (u.indexOf('youtube.com') !== -1 || u.indexOf('youtu.be') !== -1) {
    return isAudio ? { css: 'ytmusic', label: 'YT MUSIC', fallback: 'MP3' } : { css: 'youtube', label: 'YOUTUBE', fallback: 'VIDEO' };
  }
  return { css: 'media', label: isAudio ? 'MP3' : 'V\u00cdDEO', fallback: isAudio ? 'MP3' : 'MEDIA' };
}

function criarCardFila(id, tituloInicial, thumbUrl, origemBadge, urlParaFonte, isAudio) {
  removerAvisoFilaVazia();
  const card = document.createElement('div');
  card.className = 'download-card';
  card.id = 'card-' + id;

  const infoFonte = obterInfoBadgeFonte(urlParaFonte, isAudio, origemBadge);
  const labelFallback = infoFonte.fallback;
  const thumbHtml = thumbUrl
    ? '<img src="' + thumbUrl + '" onerror="this.onerror=null;this.parentNode.innerHTML=\'' + labelFallback + '\';" />'
    : labelFallback;
  const pillHtml = '<span class="source-pill ' + infoFonte.css + '">' + infoFonte.label + '</span>';

  card.innerHTML =
    '<div class="card-thumb" id="thumb-' + id + '">' + thumbHtml + '</div>' +
    '<div class="card-body">' +
    '<div class="card-title-row">' +
    '<div class="card-title-left">' + pillHtml +
    '<div class="card-title" id="title-' + id + '" title="' + tituloInicial + '">' + tituloInicial + '</div>' +
    '</div>' +
    '<div class="card-eta-pill" id="eta-' + id + '">Aguardando...</div>' +
    '</div>' +
    '<div class="progress-and-status">' +
    '<div class="progress-bar-bg"><div class="progress-bar-fill active-anim" id="fill-' + id + '"></div></div>' +
    '<div class="status-badge processing" id="status-' + id + '">' +
    '<span class="spinner" id="spin-' + id + '"></span>' +
    '<span id="statustext-' + id + '">Na fila</span>' +
    '</div>' +
    '</div>' +
    '</div>';

  queueList.prepend(card);
  return card;
}

function adicionarItemNaFilaBaixaAi(opcoes) {
  const url = (opcoes.url || '').trim();
  if (!url) return;
  const isAudio = opcoes.isAudio !== undefined ? opcoes.isAudio : true;
  const quality = opcoes.quality || '1080';
  const customTitle = opcoes.customTitle || '';
  const thumbUrl = opcoes.thumbUrl || null;
  const origem = opcoes.origem || '';
  const insertOnTimeline = opcoes.insertOnTimeline === true;
  const onFinished = opcoes.onFinished || null;

  const chaveUnica = url + '|' + (isAudio ? 'audio' : 'video');
  const agora = Date.now();
  if (ultimosDisparosMap[chaveUnica] && agora - ultimosDisparosMap[chaveUnica] < 8000) return;
  if (currentActiveTask && currentActiveTask.chaveUnica === chaveUnica) return;
  for (let q = 0; q < taskQueue.length; q++) if (taskQueue[q].chaveUnica === chaveUnica) return;
  ultimosDisparosMap[chaveUnica] = agora;

  const itemId = agora + Math.floor(Math.random() * 1000);
  let finalThumb = thumbUrl;
  if (!finalThumb) {
    const ytId = extrairIdYouTube(url);
    if (ytId) finalThumb = 'https://i.ytimg.com/vi/' + ytId + '/mqdefault.jpg';
  }

  criarCardFila(itemId, customTitle || url, finalThumb, origem, url, isAudio);
  taskQueue.push({ id: itemId, url, isAudio, quality, customTitle, origem, insertOnTimeline, chaveUnica, onFinished });
  atualizarContadorFila();
  processarProximaTarefaDaFila();
}

btnStart.addEventListener('click', () => {
  const rawUrl = urlInput.value.trim();
  if (!rawUrl) {
    alert('Cole o endere\u00e7o URL no campo antes de clicar em BAIXAR!');
    return;
  }
  iniciarFluxoDownloadUrl(rawUrl);
});

function iniciarFluxoDownloadUrl(rawUrl) {
  dispararUrlOuSpotify(rawUrl);
}

function dispararUrlOuSpotify(rawUrl) {
  urlInput.value = '';
  if (playlistNotice) playlistNotice.style.display = 'none';
  if (spotifyNotice) spotifyNotice.style.display = 'none';

  if (isLinkSpotify(rawUrl)) {
    processarLinkSpotify(rawUrl);
    return;
  }
  const eraYtMusic = rawUrl.toLowerCase().indexOf('music.youtube.com') !== -1;
  const cleanUrl = sanitizarLink(rawUrl);
  const isAudio = document.querySelector('input[name="format"]:checked').value === 'audio';
  const quality = qualitySelect.value;
  adicionarItemNaFilaBaixaAi({ url: cleanUrl, isAudio, quality, origem: eraYtMusic ? 'ytmusic' : '' });
}

// ---------------------------------------------------------------------------
// Executor multiplataforma de scripts Deno
// ---------------------------------------------------------------------------
async function executarScriptDeno(scriptMjs, argsLista, cwdOpcional) {
  const denoBin = PATHS.binDir + SEP + 'deno' + EXE_EXT;
  const runnerFile = PATHS.tmpDir + SEP + '_run_' + Date.now() + '_' + gerarSufixoAleatorio() + (IS_MAC ? '.sh' : '.bat');
  let cmdArgs = '"' + denoBin + '" run -A "' + scriptMjs + '"';
  for (const a of argsLista) cmdArgs += ' "' + a + '"';

  if (IS_MAC) {
    const shLines = [
      '#!/bin/sh',
      'export LC_ALL=en_US.UTF-8',
      'export LANG=en_US.UTF-8',
      'export PATH="' + PATHS.binDir + ':/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"',
      'xattr -dr com.apple.quarantine "' + PATHS.binDir + '" 2>/dev/null',
      'chmod -R 755 "' + PATHS.binDir + '" 2>/dev/null',
      'chmod +x "' + PATHS.binDir + '/deno" "' + PATHS.binDir + '/yt-dlp" "' + PATHS.binDir + '/ffmpeg" 2>/dev/null',
      cwdOpcional ? 'cd "' + cwdOpcional + '"' : '',
      cmdArgs,
    ].join('\n') + '\n';
    await window.api.fs.writeFile(runnerFile, shLines);
    const r = await window.api.process.createProcess('/bin/sh', [runnerFile]);
    return { pid: r.data, err: r.err, runnerFile };
  } else {
    const batLines = [
      '@echo off',
      'chcp 65001 >nul',
      'set "PATH=' + PATHS.binDir + ';%PATH%"',
      cwdOpcional ? 'cd /d "' + cwdOpcional + '"' : '',
      cmdArgs,
    ].join('\r\n');
    await window.api.fs.writeFile(runnerFile, batLines);
    const r = await window.api.process.createProcess('C:\\Windows\\System32\\cmd.exe', ['/c', runnerFile]);
    return { pid: r.data, err: r.err, runnerFile };
  }
}

// ---------------------------------------------------------------------------
// Spotify
// ---------------------------------------------------------------------------
async function processarLinkSpotify(spotifyUrl) {
  const tempCardId = 'sp-load-' + Date.now();
  criarCardFila(tempCardId, 'Lendo informa\u00e7\u00f5es do Spotify...', null, 'spotify', spotifyUrl, true);
  const statusTextEl = $('statustext-' + tempCardId);
  const etaEl = $('eta-' + tempCardId);
  const fillEl = $('fill-' + tempCardId);
  if (statusTextEl) statusTextEl.innerText = 'Buscando faixas...';
  if (etaEl) etaEl.innerText = 'Conectando...';
  if (fillEl) fillEl.style.width = '35%';

  const resolverScript = PATHS.engineDir + SEP + 'spotify_resolver.mjs';
  const reqId = Date.now();
  const outFile = PATHS.tmpDir + SEP + '_spotify_out_' + reqId + '.json';

  const exec = await executarScriptDeno(resolverScript, [spotifyUrl, outFile], '');
  if (exec.err !== 0) {
    const card = $('card-' + tempCardId);
    if (card) card.remove();
    alert('Erro ao iniciar o resolvedor do Spotify.');
    return;
  }
  const pid = exec.pid;
  const runnerFile = exec.runnerFile;

  let tentativas = 0;
  while (tentativas++ < 120) {
    const running = await window.api.process.isRunning(pid);
    if (!running.data) break;
    await sleep(300);
  }

  const outRead = await window.api.fs.readFile(outFile);
  await window.api.fs.deleteFile(runnerFile);
  await window.api.fs.deleteFile(outFile);

  const cardLoad = $('card-' + tempCardId);
  if (cardLoad) cardLoad.remove();

  if (outRead.err !== 0 || !outRead.data) {
    alert('N\u00e3o foi poss\u00edvel carregar os dados do Spotify. Verifique sua conex\u00e3o.');
    return;
  }
  try {
    const dados = JSON.parse(outRead.data);
    if (dados.status !== 'OK' || !dados.tracks || dados.tracks.length === 0) {
      alert(dados.message || 'Nenhuma m\u00fasica encontrada neste link do Spotify.');
      return;
    }
    for (const tr of dados.tracks) {
      adicionarItemNaFilaBaixaAi({
        url: tr.youtubeUrl,
        isAudio: true,
        quality: 'best',
        customTitle: tr.title,
        thumbUrl: tr.cover,
        origem: 'spotify',
      });
    }
  } catch (_) {
    alert('Erro ao processar resposta do Spotify.');
  }
}

// ---------------------------------------------------------------------------
// Motor de download com barra de progresso + ETA
// ---------------------------------------------------------------------------
function processarProximaTarefaDaFila() {
  atualizarContadorFila();
  if (isProcessingQueue || taskQueue.length === 0) return;
  isProcessingQueue = true;
  const task = taskQueue.shift();
  currentActiveTask = task;
  atualizarContadorFila();

  executarDownloadPreciso(task).then(({ sucesso, nomeArquivo }) => {
    isProcessingQueue = false;
    currentActiveTask = null;
    if (task.onFinished) {
      try { task.onFinished(sucesso, nomeArquivo); } catch (_) {}
    }
    atualizarContadorFila();
    processarProximaTarefaDaFila();
  });
}

async function executarDownloadPreciso(task) {
  const itemId = task.id;
  const startTimeDownload = Date.now() - 4000;
  const sufixoUnico = '_' + gerarSufixoAleatorio();

  const fillEl = $('fill-' + itemId);
  const statusEl = $('status-' + itemId);
  const statusTextEl = $('statustext-' + itemId);
  const spinEl = $('spin-' + itemId);
  const titleEl = $('title-' + itemId);
  const etaEl = $('eta-' + itemId);
  const thumbEl = $('thumb-' + itemId);
  let thumbJaDefinida = false;

  if (fillEl) { fillEl.style.width = '3%'; fillEl.classList.add('active-anim'); }
  if (statusTextEl) statusTextEl.innerText = 'Iniciando...';
  if (etaEl) etaEl.innerText = 'Calculando tempo...';
  if (statusEl) statusEl.className = 'status-badge downloading';

  const downloaderScript = PATHS.engineDir + SEP + 'downloader.mjs';
  const reqFile = PATHS.tmpDir + SEP + '_dl_req_' + itemId + '.json';
  const statusFile = PATHS.tmpDir + SEP + '_dl_status_' + itemId + '.json';

  const reqPayload = {
    ytdlpPath: PATHS.binDir + SEP + 'yt-dlp' + EXE_EXT,
    ffmpegPath: PATHS.binDir + SEP + 'ffmpeg' + EXE_EXT,
    ffprobePath: IS_MAC ? '' : PATHS.binDir + SEP + 'ffprobe' + EXE_EXT,
    binDir: PATHS.binDir,
    projectDir: downloadsDir,
    url: task.url,
    isAudio: task.isAudio,
    quality: task.quality,
    customTitle: task.customTitle || '',
    suffix: sufixoUnico,
  };

  await window.api.fs.writeFile(reqFile, JSON.stringify(reqPayload, null, 2));

  const exec = await executarScriptDeno(downloaderScript, [reqFile, statusFile], downloadsDir);
  if (exec.err !== 0) {
    if (fillEl) fillEl.classList.remove('active-anim');
    if (spinEl) spinEl.style.display = 'none';
    if (statusTextEl) statusTextEl.innerText = 'Erro ao iniciar';
    if (statusEl) statusEl.className = 'status-badge error';
    return { sucesso: false, nomeArquivo: '' };
  }

  const pid = exec.pid;
  const runnerFile = exec.runnerFile;
  let currentPercent = 3;

  // poll de progresso
  for (;;) {
    const stRead = await window.api.fs.readFile(statusFile);
    if (stRead.err === 0 && stRead.data) {
      try {
        const st = JSON.parse(stRead.data);
        if (st.title && st.title !== 'Obtendo informa\u00e7\u00f5es...' && titleEl && !task.customTitle) {
          titleEl.innerText = st.title;
          titleEl.title = st.title;
        }
        if (st.thumbnail && !thumbJaDefinida && thumbEl && !thumbEl.querySelector('img')) {
          thumbJaDefinida = true;
          const fb = thumbEl.innerText || 'MEDIA';
          thumbEl.innerHTML = '<img src="' + st.thumbnail + '" onerror="this.onerror=null;this.parentNode.innerHTML=\'' + fb + '\';" />';
        }
        if (typeof st.percent === 'number' && !isNaN(st.percent)) {
          currentPercent = Math.max(currentPercent, st.percent);
          if (fillEl) fillEl.style.width = currentPercent + '%';
        }
        if (st.phase === 'converting') {
          if (statusTextEl) statusTextEl.innerText = 'Otimizando ' + currentPercent + '%';
          if (statusEl) statusEl.className = 'status-badge processing';
          if (etaEl) {
            let t = st.eta && st.eta !== '00:00' ? 'Resta ' + st.eta : 'Finalizando...';
            if (st.speed) t += ' \u2022 ' + st.speed;
            etaEl.innerText = t;
          }
        } else if (st.phase === 'processing') {
          if (statusTextEl) statusTextEl.innerText = 'Processando ' + currentPercent + '%';
          if (statusEl) statusEl.className = 'status-badge processing';
          if (etaEl) etaEl.innerText = 'Quase pronto...';
        } else if (st.phase === 'downloading') {
          if (statusTextEl) statusTextEl.innerText = 'Baixando ' + currentPercent + '%';
          if (statusEl) statusEl.className = 'status-badge downloading';
          if (etaEl) {
            const partes = [];
            if (st.eta) partes.push('Resta ' + st.eta);
            if (st.speed) partes.push(st.speed);
            etaEl.innerText = partes.length ? partes.join(' \u2022 ') : 'Baixando...';
          }
        }
      } catch (_) {}
    }

    const running = await window.api.process.isRunning(pid);
    if (!running.data) break;
    await sleep(250);
  }

  // finalizacao
  const finalRead = await window.api.fs.readFile(statusFile);
  let okDownload = true;
  let specificPath = '';
  let finalJson = null;
  if (finalRead.err === 0 && finalRead.data) {
    try {
      finalJson = JSON.parse(finalRead.data);
      if (finalJson.success === false) okDownload = false;
      if (finalJson.finalFilePath) specificPath = finalJson.finalFilePath;
    } catch (_) {}
  }

  await window.api.fs.deleteFile(reqFile);
  await window.api.fs.deleteFile(statusFile);
  await window.api.fs.deleteFile(runnerFile);

  if (!okDownload) {
    const cardEl = $('card-' + itemId);
    if (cardEl) cardEl.classList.add('card-error');
    if (fillEl) { fillEl.style.width = '100%'; fillEl.classList.remove('active-anim'); }
    if (spinEl) spinEl.style.display = 'none';
    const errMsg = finalJson && finalJson.error ? finalJson.error : 'Falha ao baixar m\u00eddia.';
    if (statusTextEl) statusTextEl.innerText = 'Erro ao baixar';
    if (etaEl) {
      etaEl.innerText = errMsg.length > 32 ? errMsg.substring(0, 30) + '...' : errMsg;
      etaEl.title = errMsg;
    }
    if (statusEl) statusEl.className = 'status-badge error';
    return { sucesso: false, nomeArquivo: '' };
  }

  if (statusTextEl) statusTextEl.innerText = 'Importando...';
  if (etaEl) etaEl.innerText = 'No DaVinci Resolve';
  if (statusEl) statusEl.className = 'status-badge processing';
  if (fillEl) fillEl.style.width = '98%';

  const res = await window.api.resolveCall('import_media', {
    filePath: specificPath,
    insertOnTimeline: task.insertOnTimeline,
  });

  const cardElFim = $('card-' + itemId);
  if (res && res.status === 'SUCCESS') {
    if (cardElFim) cardElFim.classList.add('card-done');
    const nomeLimpo = res.name || '';
    if (titleEl) { titleEl.innerText = nomeLimpo; titleEl.title = nomeLimpo; }
    if (fillEl) fillEl.style.width = '100%';
    if (spinEl) spinEl.style.display = 'none';
    if (statusTextEl) statusTextEl.innerText = 'Conclu\u00eddo!';
    if (etaEl) etaEl.innerText = res.inserted ? 'No Timeline' : 'No Media Pool';
    if (statusEl) statusEl.className = 'status-badge';
    return { sucesso: true, nomeArquivo: nomeLimpo };
  } else if (res && (res.status === 'NOT_CONNECTED' || res.status === 'NO_PYTHON' || res.status === 'NO_PROJECT')) {
    // Baixou normalmente; so nao ha editor conectado para importar (uso standalone).
    if (cardElFim) cardElFim.classList.add('card-done');
    const nomeLimpo = specificPath ? specificPath.replace(/\\/g, '/').split('/').pop() : '';
    if (titleEl && nomeLimpo) { titleEl.innerText = nomeLimpo; titleEl.title = nomeLimpo; }
    if (fillEl) fillEl.style.width = '100%';
    if (spinEl) spinEl.style.display = 'none';
    if (statusTextEl) statusTextEl.innerText = 'Baixado!';
    if (etaEl) { etaEl.innerText = 'Salvo em: ' + downloadsDir; etaEl.title = downloadsDir; }
    if (statusEl) statusEl.className = 'status-badge';
    return { sucesso: true, nomeArquivo: nomeLimpo };
  } else {
    if (cardElFim) cardElFim.classList.add('card-error');
    if (fillEl) fillEl.style.width = '85%';
    if (spinEl) spinEl.style.display = 'none';
    if (statusTextEl) statusTextEl.innerText = 'Erro ao importar';
    if (etaEl) etaEl.innerText = (res && res.message) ? res.message : 'Verifique o Resolve';
    if (statusEl) statusEl.className = 'status-badge error';
    return { sucesso: false, nomeArquivo: '' };
  }
}

// ---------------------------------------------------------------------------
// ABA 2: RECONHECER MUSICA
// ---------------------------------------------------------------------------
function mostrarErroReconhecimento(msg) {
  if (!msg) {
    recError.style.display = 'none';
    recError.innerText = '';
    return;
  }
  recError.innerText = msg;
  recError.style.display = 'block';
}

function definirEstadoEscuta(ativo, titulo, sub) {
  isRecListening = ativo;
  if (ativo) {
    recStage.classList.add('listening');
    recOrbText.innerText = 'OUVINDO';
    recStageTitle.innerText = titulo || 'Ouvindo o \u00e1udio do computador...';
    recStageSub.innerText = sub || 'Capturando o que est\u00e1 tocando...';
  } else {
    recStage.classList.remove('listening');
    recOrbText.innerText = 'OUVIR';
    recStageTitle.innerText = titulo || 'Reconhecer M\u00fasica do Computador';
    recStageSub.innerText = sub || 'D\u00ea play na m\u00fasica (navegador, Spotify, player...) e clique acima para identificar e baixar.';
  }
}

async function capturarAudioComputador(seconds) {
  // Loopback nativo do Chromium/Electron: captura o que toca no PC sem drivers.
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  const audioTracks = stream.getAudioTracks();
  if (!audioTracks || audioTracks.length === 0) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('Nenhuma faixa de audio foi capturada.');
  }
  const audioStream = new MediaStream(audioTracks);
  stream.getVideoTracks().forEach((t) => t.stop());

  const rec = new MediaRecorder(audioStream, { mimeType: 'audio/webm' });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
  rec.start();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  await new Promise((r) => { rec.onstop = r; rec.stop(); });
  audioTracks.forEach((t) => t.stop());

  const blob = new Blob(chunks, { type: 'audio/webm' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  const res = await window.api.saveAudio(buf);
  if (!res || !res.ok) throw new Error((res && res.error) || 'falha ao salvar a captura');
  return { filePath: res.filePath, seconds };
}

btnRecListen.addEventListener('click', async () => {
  if (isRecListening) return;
  pararPreviewAudio();
  mostrarErroReconhecimento('');
  definirEstadoEscuta(true, 'Ouvindo o \u00e1udio do computador...', 'Capturando o que est\u00e1 tocando agora (navegador, player, etc.)...');

  let cap;
  try {
    cap = await capturarAudioComputador(12);
  } catch (e) {
    definirEstadoEscuta(false);
    mostrarErroReconhecimento('N\u00e3o consegui capturar o \u00e1udio do computador: ' + (e && e.message ? e.message : e));
    return;
  }

  const dados = {
    timelineName: '\u00c1udio do computador',
    playheadSeconds: 0,
    playheadFormatted: 'ao vivo',
    candidates: [{
      clipName: '\u00c1udio do computador',
      trackName: 'Sistema',
      mediaPath: cap.filePath,
      startOffset: 0,
      clipDuration: cap.seconds || 12,
    }],
  };

  definirEstadoEscuta(true, 'Ouvindo o \u00e1udio do computador', 'Reconhecendo m\u00fasica e buscando link oficial no YouTube...');
  await executarMotorReconhecimento(dados);
});

async function executarMotorReconhecimento(dadosTimeline) {
  const ffmpegBin = PATHS.binDir + SEP + 'ffmpeg' + EXE_EXT;
  const recognizeScript = PATHS.engineDir + SEP + 'recognize.mjs';
  const reqId = Date.now();
  const reqFile = PATHS.tmpDir + SEP + '_rec_req_' + reqId + '.json';
  const outFile = PATHS.tmpDir + SEP + '_rec_out_' + reqId + '.json';

  const payload = {
    ffmpegPath: ffmpegBin,
    tempDir: PATHS.tmpDir,
    sequenceName: dadosTimeline.timelineName || '',
    playheadSeconds: dadosTimeline.playheadSeconds || 0,
    playheadFormatted: dadosTimeline.playheadFormatted || '00:00',
    candidates: dadosTimeline.candidates || [],
  };

  await window.api.fs.writeFile(reqFile, JSON.stringify(payload, null, 2));
  const exec = await executarScriptDeno(recognizeScript, [reqFile, outFile], '');
  if (exec.err !== 0) {
    await window.api.fs.deleteFile(reqFile);
    await window.api.fs.deleteFile(exec.runnerFile);
    definirEstadoEscuta(false);
    mostrarErroReconhecimento('Erro ao iniciar o motor de reconhecimento.');
    return;
  }
  const pid = exec.pid;
  const runnerFile = exec.runnerFile;

  let tentativas = 0;
  while (tentativas++ < 85) {
    const running = await window.api.process.isRunning(pid);
    if (!running.data) break;
    await sleep(300);
  }

  const outRead = await window.api.fs.readFile(outFile);
  await window.api.fs.deleteFile(reqFile);
  await window.api.fs.deleteFile(outFile);
  await window.api.fs.deleteFile(runnerFile);

  if (outRead.err !== 0 || !outRead.data) {
    definirEstadoEscuta(false);
    mostrarErroReconhecimento('Sem resposta do servidor de reconhecimento. Verifique sua conex\u00e3o.');
    return;
  }
  try {
    processarResultadoReconhecimento(JSON.parse(outRead.data));
  } catch (_) {
    definirEstadoEscuta(false);
    mostrarErroReconhecimento('Erro ao ler resposta do reconhecedor.');
  }
}

function processarResultadoReconhecimento(res) {
  if (!res || res.status !== 'MATCH') {
    definirEstadoEscuta(false, 'M\u00fasica n\u00e3o identificada neste ponto', 'Avance o playhead para um trecho onde a m\u00fasica esteja mais limpa e tente novamente.');
    mostrarErroReconhecimento(res && res.message ? res.message : 'Nenhuma m\u00fasica identificada neste trecho.');
    return;
  }
  lastRecMatch = res;
  const nomeCompleto = (res.artist ? res.artist + ' - ' : '') + (res.title || 'M\u00fasica');
  definirEstadoEscuta(false, 'M\u00fasica Identificada!', nomeCompleto);
  exibirShowcaseNoMesmoBloco(res);
  salvarItemHistoricoReconhecimento(res);
  if (res.youtubeUrl) {
    res.jaEnviadoFila = true;
    enviarMusicaParaBaixaAi(res, true);
  }
}

function enviarMusicaParaBaixaAi(res, isAuto) {
  if (!res || !res.youtubeUrl) return;
  const nomeCompleto = (res.artist ? res.artist + ' - ' : '') + (res.title || 'M\u00fasica');
  const capa = res.cover || res.youtubeThumb || '';
  selecionarModoAudio();
  dispararDownloadReconhecido(res.youtubeUrl, nomeCompleto, capa);
}

function dispararDownloadReconhecido(ytUrl, nomeCompleto, capa) {
  if (recAutoDlStatus) {
    recAutoDlStatus.innerText = 'Baixando e inserindo na Timeline...';
    recAutoDlStatus.style.color = '#facc15';
  }
  adicionarItemNaFilaBaixaAi({
    url: ytUrl,
    isAudio: true,
    quality: 'best',
    customTitle: nomeCompleto,
    thumbUrl: capa,
    origem: 'ytmusic',
    insertOnTimeline: true,
    onFinished: (sucesso) => {
      if (!recAutoDlStatus) return;
      if (sucesso) {
        recAutoDlStatus.innerText = 'Inserida na Timeline e no Media Pool!';
        recAutoDlStatus.style.color = '#64dd17';
      } else {
        recAutoDlStatus.innerText = 'Erro ao baixar e inserir na Timeline.';
        recAutoDlStatus.style.color = '#ef4444';
      }
    },
  });
}

function exibirShowcaseNoMesmoBloco(res) {
  const imgUrl = res.cover || res.youtubeThumb || '';
  if (imgUrl) {
    recResCover.src = imgUrl;
    recResCover.style.display = 'block';
  } else {
    recResCover.style.display = 'none';
  }
  currentPreviewUrl = res.previewUrl || '';
  if (currentPreviewUrl) {
    btnRecPreview.style.display = 'flex';
    btnRecPreview.innerText = '\u25B6';
    btnRecPreview.classList.remove('playing');
  } else {
    btnRecPreview.style.display = 'none';
  }
  recResClip.innerText = (res.trackName ? res.trackName + ' \u2022 ' : '') + (res.timelineTimecode || 'Timeline');
  recResTitle.innerText = res.title || 'M\u00fasica';
  recResTitle.title = res.title || '';
  recResArtist.innerText = res.artist || 'Artista';
  recResArtist.title = res.artist || '';
  const meta = [];
  if (res.album) meta.push(res.album);
  if (res.genre) meta.push(res.genre);
  recResMeta.innerText = meta.length ? meta.join(' \u2022 ') : 'Reconhecido da Timeline';
  if (recAutoDlStatus) {
    recAutoDlStatus.innerText = 'Baixando e inserindo na Timeline...';
    recAutoDlStatus.style.color = '#facc15';
  }
  recStage.classList.remove('has-match');
  void recStage.offsetWidth;
  recStage.classList.add('has-match');
}

btnRecPreview.addEventListener('click', () => {
  if (!currentPreviewUrl) return;
  if (!audioPreviewPlayer.paused) {
    pararPreviewAudio();
  } else {
    audioPreviewPlayer.src = currentPreviewUrl;
    audioPreviewPlayer.play();
    btnRecPreview.innerText = '\u23F8';
    btnRecPreview.classList.add('playing');
  }
});
audioPreviewPlayer.addEventListener('ended', pararPreviewAudio);

function pararPreviewAudio() {
  try {
    audioPreviewPlayer.pause();
    audioPreviewPlayer.currentTime = 0;
  } catch (_) {}
  if (btnRecPreview) {
    btnRecPreview.innerText = '\u25B6';
    btnRecPreview.classList.remove('playing');
  }
}

function carregarHistoricoReconhecimento() {
  try {
    const raw = localStorage.getItem(REC_HIST_KEY);
    if (raw) recHistory = JSON.parse(raw) || [];
  } catch (_) {
    recHistory = [];
  }
  renderizarHistoricoReconhecimento();
}

function salvarItemHistoricoReconhecimento(res) {
  if (recHistory.length > 0 && recHistory[0].youtubeUrl === res.youtubeUrl && recHistory[0].title === res.title) {
    renderizarHistoricoReconhecimento();
    return;
  }
  recHistory.unshift({
    title: res.title,
    artist: res.artist,
    cover: res.cover || res.youtubeThumb || '',
    youtubeUrl: res.youtubeUrl || '',
    timelineTimecode: res.timelineTimecode || '',
  });
  if (recHistory.length > 25) recHistory = recHistory.slice(0, 25);
  try { localStorage.setItem(REC_HIST_KEY, JSON.stringify(recHistory)); } catch (_) {}
  renderizarHistoricoReconhecimento();
}

function renderizarHistoricoReconhecimento() {
  recHistoryList.innerHTML = '';
  if (!recHistory || recHistory.length === 0) {
    recHistoryList.innerHTML = '<div class="queue-empty" style="padding:14px;">Nenhuma m\u00fasica reconhecida ainda.</div>';
    return;
  }
  recHistory.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'rec-hist-item';
    const imgHtml = item.cover
      ? '<img src="' + item.cover + '" onerror="this.onerror=null;this.parentNode.innerHTML=\'MP3\';" />'
      : 'MP3';
    row.innerHTML =
      '<div class="rec-hist-thumb">' + imgHtml + '</div>' +
      '<div class="rec-hist-body">' +
      '<div class="rec-hist-song">' + (item.title || 'M\u00fasica') + '</div>' +
      '<div class="rec-hist-artist">' + (item.artist || 'Artista') + (item.timelineTimecode ? ' \u2022 ' + item.timelineTimecode : '') + '</div>' +
      '</div>' +
      '<div class="rec-hist-btns">' +
      '<button class="btn-mini dl" title="Baixar novamente para o Media Pool">Baixar</button>' +
      '</div>';
    const btnDl = row.querySelector('.btn-mini.dl');
    btnDl.addEventListener('click', () => {
      btnDl.innerText = 'Baixando...';
      enviarMusicaParaBaixaAi(item, false);
      setTimeout(() => { btnDl.innerText = 'Baixar'; }, 2500);
    });
    recHistoryList.appendChild(row);
  });
}

btnClearRecHist.addEventListener('click', () => {
  recHistory = [];
  try { localStorage.removeItem(REC_HIST_KEY); } catch (_) {}
  renderizarHistoricoReconhecimento();
});

// ---------------------------------------------------------------------------
inicializarPainel();
