/*!
 * Siberi AI Widget v2.0
 * Features: Markdown rendering, voice input, image upload (paste / file)
 * Embed: <script src="https://your-domain.com/siberi-widget.js?key=API_KEY"></script>
 */
(function () {
  'use strict';

  // ── Locate this script and parse params ─────────────────────────────────────
  var me = document.currentScript;
  if (!me) {
    var all = document.querySelectorAll('script[src*="siberi-widget"]');
    me = all[all.length - 1] || null;
  }
  if (!me) return;

  var srcUrl;
  try { srcUrl = new URL(me.src); } catch (e) { return; }

  var KEY = srcUrl.searchParams.get('key') || srcUrl.searchParams.get('token');
  if (!KEY) { console.warn('[Siberi Widget] Missing ?key= or ?token= in script src'); return; }
  var API = (srcUrl.searchParams.get('api') || srcUrl.origin) + '/api/v1';
  var USER_ID = srcUrl.searchParams.get('userId') || '';

  // ── CSS ─────────────────────────────────────────────────────────────────────
  var css = [
    // Launch button
    '#sib-btn{position:fixed;bottom:24px;right:24px;width:60px;height:60px;border-radius:50%;background:linear-gradient(135deg,#667eea,#764ba2);border:none;cursor:pointer;box-shadow:0 4px 22px rgba(102,126,234,.55);z-index:2147483647;display:flex;align-items:center;justify-content:center;transition:transform .2s,box-shadow .2s;padding:0;}',
    '#sib-btn:hover{transform:scale(1.1);box-shadow:0 6px 30px rgba(102,126,234,.7);}',
    '#sib-btn svg{width:27px;height:27px;color:white;flex-shrink:0;}',
    // Chat window
    '#sib-win{position:fixed;bottom:96px;right:24px;width:390px;height:540px;background:#fff;border-radius:20px;box-shadow:0 12px 50px rgba(0,0,0,.18);z-index:2147483646;display:flex;flex-direction:column;overflow:hidden;font-family:system-ui,-apple-system,BlinkMacSystemFont,sans-serif;transform:scale(.9) translateY(14px);opacity:0;pointer-events:none;transition:transform .28s cubic-bezier(.34,1.56,.64,1),opacity .2s;}',
    '#sib-win.sib-open{transform:scale(1) translateY(0);opacity:1;pointer-events:all;}',
    // Header
    '#sib-head{background:linear-gradient(135deg,#667eea,#764ba2);padding:14px 16px;display:flex;align-items:center;gap:11px;flex-shrink:0;}',
    '#sib-avatar{width:38px;height:38px;background:rgba(255,255,255,.2);border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;}',
    '#sib-avatar svg{width:20px;height:20px;color:white;}',
    '.sib-hinfo{flex:1;min-width:0;}',
    '#sib-name{color:#fff;font-weight:700;font-size:15px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.sib-online{display:flex;align-items:center;gap:5px;font-size:11.5px;color:rgba(255,255,255,.82);margin-top:2px;}',
    '.sib-dot{width:6px;height:6px;background:#4ade80;border-radius:50%;box-shadow:0 0 6px rgba(74,222,128,.7);}',
    '#sib-close{background:none;border:none;color:rgba(255,255,255,.7);cursor:pointer;padding:5px;border-radius:7px;display:flex;transition:background .15s;}',
    '#sib-close:hover{background:rgba(255,255,255,.15);color:#fff;}',
    '#sib-close svg{width:18px;height:18px;color:inherit;}',
    // Messages
    '#sib-msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:9px;scroll-behavior:smooth;}',
    '.sib-m{max-width:84%;padding:10px 13px;border-radius:16px;font-size:14px;line-height:1.55;word-break:break-word;animation:sibIn .2s ease;}',
    '.sib-u{align-self:flex-end;background:#667eea;color:#fff;border-bottom-right-radius:4px;white-space:pre-wrap;}',
    '.sib-a{align-self:flex-start;background:#f1f5f9;color:#1e293b;border-bottom-left-radius:4px;max-width:92%;}',
    // Markdown inside .sib-a
    '.sib-a p{margin:0 0 6px;}.sib-a p:last-child{margin-bottom:0;}',
    '.sib-a ul,.sib-a ol{margin:3px 0 8px 18px;padding:0;}.sib-a li{margin-bottom:3px;}',
    '.sib-a strong{font-weight:700;}.sib-a em{font-style:italic;}',
    '.sib-a code{background:rgba(0,0,0,.08);border-radius:3px;padding:1px 5px;font-family:monospace;font-size:.87em;}',
    '.sib-a pre{background:#1a202c;border-radius:8px;padding:10px 13px;overflow-x:auto;margin:6px 0;}.sib-a pre code{background:none;color:#a9d8a0;font-size:12.5px;padding:0;}',
    '.sib-a a{color:#667eea;text-decoration:underline;}',
    '.sib-a h2,.sib-a h3,.sib-a h4{font-weight:700;margin:8px 0 4px;line-height:1.3;}',
    '.sib-a h2{font-size:1.05em;}.sib-a h3{font-size:1em;}.sib-a h4{font-size:.95em;}',
    '.sib-a hr{border:none;border-top:1px solid rgba(0,0,0,.1);margin:8px 0;}',
    // Markdown tables
    '.sib-tbl-wrap{overflow-x:auto;margin:7px 0;border-radius:8px;border:1px solid #e2e8f0;}',
    '.sib-tbl{border-collapse:collapse;width:100%;font-size:12.5px;}',
    '.sib-tbl th{background:#f1f5f9;font-weight:600;color:#334155;padding:7px 11px;text-align:left;border-bottom:2px solid #e2e8f0;white-space:nowrap;}',
    '.sib-tbl td{padding:6px 11px;color:#1e293b;border-bottom:1px solid #f1f5f9;vertical-align:top;}',
    '.sib-tbl tr:last-child td{border-bottom:none;}',
    '.sib-tbl tbody tr:nth-child(even) td{background:#fafbfc;}',
    // AI images
    '.sib-ai-img{display:block;max-width:100%;border-radius:10px;margin-top:7px;border:1px solid rgba(0,0,0,.07);cursor:zoom-in;}',
    // User image in message
    '.sib-u-img{display:block;max-width:100%;max-height:180px;border-radius:8px;margin-bottom:5px;object-fit:contain;}',
    // Typing
    '.sib-typing{display:flex;gap:5px;align-items:center;padding:12px 15px;}',
    '.sib-typing span{display:inline-block;width:7px;height:7px;background:#94a3b8;border-radius:50%;animation:sibDot 1.4s infinite;}',
    '.sib-typing span:nth-child(2){animation-delay:.2s;}.sib-typing span:nth-child(3){animation-delay:.4s;}',
    '@keyframes sibDot{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-5px)}}',
    '@keyframes sibIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}',
    // Image preview bar
    '#sib-img-bar{display:none;align-items:flex-start;gap:7px;padding:7px 10px;background:#f0f4ff;border-top:1.5px solid #c7d2fe;flex-shrink:0;}',
    '#sib-img-bar.sib-bar-show{display:flex;}',
    '#sib-img-thumb{height:56px;max-width:110px;object-fit:cover;border-radius:5px;}',
    '#sib-img-rm{background:rgba(0,0,0,.5);border:none;color:#fff;border-radius:50%;width:18px;height:18px;cursor:pointer;font-size:13px;line-height:1;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;}',
    '#sib-img-rm:hover{background:rgba(0,0,0,.75);}',
    // Input row
    '#sib-inp{display:flex;padding:10px 12px;border-top:1px solid #e2e8f0;gap:7px;flex-shrink:0;background:#fff;align-items:flex-end;}',
    '#sib-txt{flex:1;padding:9px 12px;border:2px solid #e2e8f0;border-radius:10px;outline:none;font-size:14px;font-family:inherit;line-height:1.4;resize:none;overflow-y:hidden;min-height:38px;max-height:96px;}',
    '#sib-txt:focus{border-color:#667eea;}',
    // Action buttons
    '.sib-icon-btn{background:#f1f5f9;border:2px solid #e2e8f0;color:#64748b;border-radius:9px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .18s;padding:8px;}',
    '.sib-icon-btn svg{width:17px;height:17px;}',
    '.sib-icon-btn:hover{background:#e8f0fe;border-color:#667eea;color:#667eea;}',
    '.sib-icon-btn:disabled{opacity:.45;cursor:default;}',
    '#sib-mic.sib-mic-active{background:linear-gradient(135deg,#ef4444,#dc2626);border-color:transparent;color:#fff;box-shadow:0 3px 12px rgba(239,68,68,.4);}',
    '#sib-mic.sib-mic-active:hover{background:linear-gradient(135deg,#dc2626,#b91c1c);border-color:transparent;color:#fff;}',
    '#sib-go{background:linear-gradient(135deg,#667eea,#764ba2);border:none;color:#fff;border-radius:9px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:opacity .2s;padding:9px 13px;}',
    '#sib-go svg{width:17px;height:17px;}',
    '#sib-go:disabled{opacity:.45;cursor:default;}',
    // Responsive
    '@media(max-width:480px){#sib-win{right:0;bottom:0;width:100%;height:85dvh;border-radius:20px 20px 0 0;}#sib-btn{bottom:16px;right:16px;}}',
  ].join('');

  var styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ── SVG icons ────────────────────────────────────────────────────────────────
  function mkSvg(body) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>';
  }
  var I_BOT   = mkSvg('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/><line x1="12" y1="3" x2="12" y2="5"/><circle cx="9" cy="16" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="16" r="1" fill="currentColor" stroke="none"/>');
  var I_SEND  = mkSvg('<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2" fill="currentColor" stroke="none"/>');
  var I_CLOSE = mkSvg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>');
  var I_MIC   = mkSvg('<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>');
  var I_MICOF = mkSvg('<line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>');
  var I_IMG   = mkSvg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>');
  var I_SPIN  = mkSvg('<path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>');

  // ── Markdown → HTML renderer ─────────────────────────────────────────────────
  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function inlineMd(text) {
    text = esc(text);
    // Bold
    text = text.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
    // Italic
    text = text.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');
    // Inline code
    text = text.replace(/`([^`\n]+?)`/g, '<code>$1</code>');
    // Links
    text = text.replace(/(https?:\/\/[^\s<>"')\]]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
    return text;
  }

  function renderTable(rows) {
    if (rows.length === 0) return '';
    function parseRow(l) { return l.split('|').slice(1,-1).map(function(c){return c.trim();}); }
    function isSep(l) { return /^\|[\s\-:|]+\|$/.test(l.trim()); }
    var headerCols = parseRow(rows[0]);
    var body = rows.filter(function(l,i){ return i>0 && !isSep(l); });
    var h = '<div class="sib-tbl-wrap"><table class="sib-tbl"><thead><tr>';
    headerCols.forEach(function(c){ h += '<th>'+inlineMd(c)+'</th>'; });
    h += '</tr></thead><tbody>';
    body.forEach(function(row){
      h += '<tr>';
      parseRow(row).forEach(function(c){ h += '<td>'+inlineMd(c)+'</td>'; });
      h += '</tr>';
    });
    h += '</tbody></table></div>';
    return h;
  }

  function renderMd(text) {
    if (!text) return '';
    var html = '';

    // Extract code blocks first
    var segments = [];
    var codeRe = /```(\w*)\r?\n?([\s\S]*?)```/g;
    var last = 0, m;
    while ((m = codeRe.exec(text)) !== null) {
      if (m.index > last) segments.push({ t: 'text', v: text.slice(last, m.index) });
      segments.push({ t: 'code', lang: m[1], v: m[2].trimEnd() });
      last = m.index + m[0].length;
    }
    if (last < text.length) segments.push({ t: 'text', v: text.slice(last) });

    segments.forEach(function(seg) {
      if (seg.t === 'code') {
        html += '<pre><code>' + esc(seg.v) + '</code></pre>';
        return;
      }

      var lines = seg.v.split('\n');
      var i = 0;
      while (i < lines.length) {
        var line = lines[i];

        // Table
        if (/^\|.+\|/.test(line)) {
          var tbl = [];
          while (i < lines.length && /^\|.+\|/.test(lines[i])) { tbl.push(lines[i]); i++; }
          html += renderTable(tbl);
          continue;
        }

        // Heading
        var hm = line.match(/^(#{1,4})\s+(.+)/);
        if (hm) {
          var lvl = Math.min(hm[1].length + 1, 5);
          html += '<h'+lvl+'>'+inlineMd(hm[2])+'</h'+lvl+'>';
          i++; continue;
        }

        // HR
        if (/^---+$/.test(line.trim())) { html += '<hr>'; i++; continue; }

        // Unordered list
        if (/^[-*•·–—]\s/.test(line)) {
          html += '<ul>';
          while (i < lines.length && /^[-*•·–—]\s/.test(lines[i])) {
            html += '<li>'+inlineMd(lines[i].replace(/^[-*•·–—]\s+/,''))+'</li>';
            i++;
          }
          html += '</ul>';
          continue;
        }

        // Ordered list
        if (/^\d+\.\s/.test(line)) {
          html += '<ol>';
          while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
            html += '<li>'+inlineMd(lines[i].replace(/^\d+\.\s+/,''))+'</li>';
            i++;
          }
          html += '</ol>';
          continue;
        }

        // Empty line
        if (line.trim() === '') { i++; continue; }

        // Paragraph — collect consecutive plain lines
        var pLines = [];
        while (i < lines.length && lines[i].trim() !== '' &&
          !/^(#{1,4}\s|[-*•·–—]\s|\d+\.\s|---+$|\|.+\|)/.test(lines[i])) {
          pLines.push(lines[i]); i++;
        }
        if (pLines.length) html += '<p>' + pLines.map(inlineMd).join('<br>') + '</p>';
      }
    });

    return html;
  }

  // ── Build DOM ────────────────────────────────────────────────────────────────
  var btn = document.createElement('button');
  btn.id = 'sib-btn'; btn.title = 'Открыть чат';
  btn.innerHTML = I_BOT;
  document.body.appendChild(btn);

  var win = document.createElement('div');
  win.id = 'sib-win';
  win.innerHTML =
    '<div id="sib-head">' +
      '<div id="sib-avatar">'+I_BOT+'</div>' +
      '<div class="sib-hinfo">' +
        '<span id="sib-name">AI-ассистент</span>' +
        '<div class="sib-online"><div class="sib-dot"></div><span>Онлайн</span></div>' +
      '</div>' +
      '<button id="sib-close" title="Закрыть">'+I_CLOSE+'</button>' +
    '</div>' +
    '<div id="sib-msgs"></div>' +
    '<div id="sib-img-bar">' +
      '<img id="sib-img-thumb" alt=""/>' +
      '<button id="sib-img-rm" title="Убрать">×</button>' +
    '</div>' +
    '<div id="sib-inp">' +
      '<textarea id="sib-txt" placeholder="Напишите сообщение..." rows="1"></textarea>' +
      '<button class="sib-icon-btn" id="sib-attach" title="Прикрепить изображение">'+I_IMG+'</button>' +
      '<button class="sib-icon-btn" id="sib-mic" title="Голосовой ввод">'+I_MIC+'</button>' +
      '<button id="sib-go" title="Отправить">'+I_SEND+'</button>' +
    '</div>';
  document.body.appendChild(win);

  var msgsEl  = win.querySelector('#sib-msgs');
  var txtEl   = win.querySelector('#sib-txt');
  var goEl    = win.querySelector('#sib-go');
  var nameEl  = win.querySelector('#sib-name');
  var micBtn  = win.querySelector('#sib-mic');
  var attBtn  = win.querySelector('#sib-attach');
  var imgBar  = win.querySelector('#sib-img-bar');
  var imgThumb = win.querySelector('#sib-img-thumb');
  var imgRm   = win.querySelector('#sib-img-rm');

  // Hidden file input
  var fileInput = document.createElement('input');
  fileInput.type = 'file'; fileInput.accept = 'image/*'; fileInput.style.display = 'none';
  document.body.appendChild(fileInput);

  // ── Load AI name ─────────────────────────────────────────────────────────────
  fetch(API + '/config', { headers: { Authorization: 'Bearer ' + KEY } })
    .then(function(r){ return r.json(); })
    .then(function(d){ if (d.success && d.config && d.config.aiName) nameEl.textContent = d.config.aiName; })
    .catch(function(){});

  // ── Toggle open/close ────────────────────────────────────────────────────────
  var isOpen = false;
  function toggle() {
    isOpen = !isOpen;
    win.classList.toggle('sib-open', isOpen);
    if (isOpen) setTimeout(function(){ txtEl.focus(); }, 260);
  }
  btn.addEventListener('click', toggle);
  win.querySelector('#sib-close').addEventListener('click', toggle);

  // ── Message helpers ──────────────────────────────────────────────────────────
  function scrollBot() { msgsEl.scrollTop = msgsEl.scrollHeight; }

  function addTyping() {
    var d = document.createElement('div');
    d.className = 'sib-m sib-a sib-typing';
    d.innerHTML = '<span></span><span></span><span></span>';
    msgsEl.appendChild(d); scrollBot(); return d;
  }

  function resolveTyping(typingEl, html) {
    typingEl.className = 'sib-m sib-a';
    typingEl.innerHTML = html;
    scrollBot();
  }

  function addUserMsg(text, imgDataUrl) {
    var d = document.createElement('div');
    d.className = 'sib-m sib-u';
    if (imgDataUrl) {
      var img = document.createElement('img');
      img.className = 'sib-u-img'; img.src = imgDataUrl; img.alt = '';
      d.appendChild(img);
    }
    if (text) {
      var t = document.createTextNode(text);
      d.appendChild(t);
    }
    msgsEl.appendChild(d); scrollBot();
  }

  function addAiImg(src) {
    var img = document.createElement('img');
    img.className = 'sib-ai-img'; img.src = src; img.alt = '';
    img.addEventListener('click', function(){ window.open(src, '_blank'); });
    msgsEl.appendChild(img); scrollBot();
  }

  // ── Image handling ───────────────────────────────────────────────────────────
  var pendingImg = null;

  function showImgBar(dataUrl) {
    pendingImg = dataUrl;
    imgThumb.src = dataUrl;
    imgBar.classList.add('sib-bar-show');
  }
  function clearImgBar() {
    pendingImg = null;
    imgBar.classList.remove('sib-bar-show');
    imgThumb.src = '';
  }
  imgRm.addEventListener('click', clearImgBar);

  function handleImageFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    var reader = new FileReader();
    reader.onload = function(e) {
      var raw = e.target.result;
      var image = new Image();
      image.onload = function() {
        var maxPx = 1920;
        var scale = Math.min(1, maxPx / Math.max(image.width, image.height));
        var w = Math.round(image.width * scale);
        var h = Math.round(image.height * scale);
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(image, 0, 0, w, h);
        showImgBar(canvas.toDataURL('image/jpeg', 0.85));
        txtEl.focus();
      };
      image.src = raw;
    };
    reader.readAsDataURL(file);
  }

  attBtn.addEventListener('click', function(){ fileInput.click(); });
  fileInput.addEventListener('change', function(){ if (this.files[0]) { handleImageFile(this.files[0]); this.value = ''; } });
  win.addEventListener('paste', function(e) {
    var items = Array.from((e.clipboardData || {}).items || []);
    var item = items.find(function(it){ return it.type.startsWith('image/'); });
    if (item) { e.preventDefault(); handleImageFile(item.getAsFile()); }
  });

  // ── Voice input ──────────────────────────────────────────────────────────────
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var recog, isRecording = false;

  if (!SR) {
    micBtn.style.display = 'none';
  } else {
    micBtn.addEventListener('click', function() {
      if (isRecording) { recog && recog.stop(); return; }
      recog = new SR();
      recog.lang = 'ru-RU';
      recog.interimResults = true;
      recog.continuous = false;
      recog.onstart = function() {
        isRecording = true;
        micBtn.classList.add('sib-mic-active');
        micBtn.innerHTML = I_MICOF;
        txtEl.placeholder = '🎙 Говорите...';
      };
      recog.onresult = function(e) {
        var final = '', interim = '';
        for (var i = 0; i < e.results.length; i++) {
          var t = e.results[i][0].transcript;
          if (e.results[i].isFinal) final += t; else interim += t;
        }
        txtEl.value = (final + interim).trim();
        autoHeight();
      };
      recog.onend = function() {
        isRecording = false;
        micBtn.classList.remove('sib-mic-active');
        micBtn.innerHTML = I_MIC;
        txtEl.placeholder = 'Напишите сообщение...';
        if (txtEl.value.trim()) txtEl.focus();
      };
      recog.onerror = function(e) {
        if (e.error !== 'aborted') console.warn('[Siberi Widget] Speech:', e.error);
        isRecording = false;
        micBtn.classList.remove('sib-mic-active');
        micBtn.innerHTML = I_MIC;
        txtEl.placeholder = 'Напишите сообщение...';
      };
      recog.start();
    });
  }

  // ── State ────────────────────────────────────────────────────────────────────
  var busy = false;
  function setDisabled(v) {
    txtEl.disabled = v; goEl.disabled = v; attBtn.disabled = v;
    if (micBtn.style.display !== 'none') micBtn.disabled = v;
    busy = v;
  }

  // ── Polling ──────────────────────────────────────────────────────────────────
  function poll(taskId, typingEl) {
    fetch(API + '/result/' + taskId, { headers: { Authorization: 'Bearer ' + KEY } })
      .then(function(r){ return r.json(); })
      .then(function(d) {
        if (d.status === 'completed') {
          resolveTyping(typingEl, renderMd(d.result || '✓'));
          (d.attachments || []).forEach(addAiImg);
          setDisabled(false);
        } else if (d.status === 'error') {
          resolveTyping(typingEl, esc('❌ ' + (d.error || 'Ошибка')));
          setDisabled(false);
        } else {
          setTimeout(function(){ poll(taskId, typingEl); }, 1500);
        }
      })
      .catch(function(){ setTimeout(function(){ poll(taskId, typingEl); }, 2500); });
  }

  // ── Send ─────────────────────────────────────────────────────────────────────
  function send() {
    var t = txtEl.value.trim();
    if ((!t && !pendingImg) || busy) return;
    var sentText = t || '(изображение)';
    var sentImg = pendingImg;
    txtEl.value = '';
    autoHeight();
    clearImgBar();
    setDisabled(true);

    addUserMsg(sentText !== '(изображение)' ? sentText : '', sentImg);
    var typing = addTyping();

    var body = { prompt: sentText, platform: 'web' };
    if (USER_ID) body.platformUserId = USER_ID;
    if (sentImg) body.image = sentImg;

    fetch(API + '/analyze', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function(r){ return r.json(); })
      .then(function(d) {
        if (d.taskId) {
          setTimeout(function(){ poll(d.taskId, typing); }, 1500);
        } else {
          resolveTyping(typing, esc('❌ ' + (d.error || 'Ошибка')));
          setDisabled(false);
        }
      })
      .catch(function() {
        resolveTyping(typing, esc('❌ Ошибка соединения'));
        setDisabled(false);
      });
  }

  // ── Input helpers ────────────────────────────────────────────────────────────
  function autoHeight() {
    txtEl.style.height = 'auto';
    txtEl.style.height = Math.min(txtEl.scrollHeight, 96) + 'px';
  }

  goEl.addEventListener('click', send);
  txtEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  txtEl.addEventListener('input', autoHeight);

})();
