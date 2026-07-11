'use strict';

const {
  Plugin, ItemView, PluginSettingTab, Setting, Modal, Menu, Notice, setIcon, requestUrl, MarkdownRenderer
} = require('obsidian');

const VIEW_TYPE = 'ai-chat-view';
const VIEW_TYPE_GALLERY = 'recipe-gallery-view';

const DEFAULT_SETTINGS = {
  baseUrl: 'https://api.groq.com/openai/v1',
  apiKey: '',
  models: 'llama-3.3-70b-versatile\nopenai/gpt-oss-120b\nopenai/gpt-oss-20b',
  templatePath: 'Рецепты/Новый рецепт (шаблон).md',
  examplePath: 'Рецепты/Блинчики.md',
  recipesFolder: 'Рецепты',
  visionModel: 'meta-llama/llama-4-scout-17b-16e-instruct',
  openBookOnStart: true,
  categoriesList: 'Завтраки\nОсновные блюда\nСупы\nСалаты\nВыпечка\nДесерты\nНапитки\nЗакуски',
  tagsList: 'Быстро\nНа каждый день\nПраздничное\nПостное\nВегетарианское',
  systemPrompt:
    'Ты аккуратный помощник по кулинарным рецептам внутри Obsidian. ' +
    'Отвечай по-русски. Сохраняй Markdown-форматирование. ' +
    'Когда просят изменить заметку — верни её полный обновлённый текст. Ничего не выдумывай.'
};

/* ─────────────── Чат-панель ─────────────── */
class ChatView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.messages = [];
    this.pendingImages = [];
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Поварёнок'; }
  getIcon() { return 'chef-hat'; }

  async onOpen() {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass('ai-chat-root');

    const toolbar = root.createDiv('ai-chat-toolbar');
    toolbar.createEl('span', { cls: 'ai-chat-ctx', text: 'Поварёнок' });
    const clearBtn = toolbar.createEl('button', { text: 'Очистить', cls: 'ai-chat-clear' });
    clearBtn.onclick = () => { this.messages = []; this.messagesEl.empty(); };

    this.messagesEl = root.createDiv('ai-chat-messages');

    this.imgIndicator = root.createDiv('ai-chat-imgind');

    const quick = root.createDiv('ai-chat-quick');
    quick.createEl('button', { cls: 'ai-chat-qbtn', text: '✨ По шаблону' }).onclick = () => { this.inputEl.value = 'Напиши рецепт по шаблону: '; this.inputEl.focus(); };
    quick.createEl('button', { cls: 'ai-chat-qbtn', text: '🔧 Исправить' }).onclick = () => { this.inputEl.value = 'Исправь в этом рецепте: '; this.inputEl.focus(); };
    quick.createEl('button', { cls: 'ai-chat-qbtn', text: '🔥 Калории' }).onclick = () => { this.inputEl.value = 'Посчитай калории этого рецепта'; this.inputEl.focus(); };

    const inputRow = root.createDiv('ai-chat-input-row');

    const plusBtn = inputRow.createEl('button', { cls: 'ai-chat-plus', text: '＋', attr: { title: 'Добавить фото или файл' } });
    const galleryInput = inputRow.createEl('input', { type: 'file', attr: { accept: 'image/*', multiple: '', style: 'display:none' } });
    galleryInput.onchange = () => { for (const f of Array.from(galleryInput.files || [])) this.loadImageFile(f); galleryInput.value = ''; };
    const anyInput = inputRow.createEl('input', { type: 'file', attr: { multiple: '', style: 'display:none' } });
    anyInput.onchange = () => { for (const f of Array.from(anyInput.files || [])) { if (f.type && f.type.startsWith('image/')) this.loadImageFile(f); else new Notice('Пока поддерживаются только изображения'); } anyInput.value = ''; };
    plusBtn.onclick = (e) => {
      const menu = new Menu();
      menu.addItem((i) => i.setTitle('Фото из галереи').setIcon('image').onClick(() => galleryInput.click()));
      menu.addItem((i) => i.setTitle('Файл').setIcon('paperclip').onClick(() => anyInput.click()));
      menu.showAtMouseEvent(e);
    };

    this.inputEl = inputRow.createEl('textarea', { cls: 'ai-chat-input', attr: { rows: '1', placeholder: 'Сообщение' } });

    this.micBtn = inputRow.createEl('button', { cls: 'ai-chat-mic', attr: { title: 'Голосовой ввод' } });
    setIcon(this.micBtn, 'mic');
    this.micBtn.onclick = () => this.toggleVoice();

    const sendBtn = inputRow.createEl('button', { cls: 'ai-chat-send', text: '↑', attr: { title: 'Отправить' } });
    sendBtn.onclick = () => this.send();

    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); }
    });
    this.inputEl.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const it of items) {
        if (it.type && it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) { this.loadImageFile(f); e.preventDefault(); } }
      }
    });
  }

  toggleVoice() {
    if (this.recognition) { this.voiceStopped = true; try { this.recognition.stop(); } catch (e) {} return; }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { new Notice('Голосовой ввод здесь недоступен — используй микрофон на клавиатуре'); this.inputEl.focus(); return; }
    try {
      const rec = new SR();
      rec.lang = 'ru-RU'; rec.continuous = true; rec.interimResults = false; rec.maxAlternatives = 1;
      this.voiceStopped = false;
      rec.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) {
            const t = (e.results[i][0].transcript || '').trim();
            if (t) this.inputEl.value = (this.inputEl.value ? this.inputEl.value + ' ' : '') + t;
          }
        }
      };
      rec.onerror = (ev) => {
        if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') { this.voiceStopped = true; new Notice('Нет доступа к микрофону'); }
        else if (ev.error !== 'no-speech' && ev.error !== 'aborted') new Notice('Ошибка распознавания: ' + ev.error);
      };
      rec.onend = () => {
        // движок сам остановился (пауза/таймаут) — продолжаем слушать, пока не нажмут стоп
        if (!this.voiceStopped) { try { rec.start(); return; } catch (e) {} }
        this.recognition = null;
        if (this.micBtn) { this.micBtn.removeClass('ai-chat-mic-rec'); setIcon(this.micBtn, 'mic'); }
      };
      rec.start();
      this.recognition = rec;
      if (this.micBtn) { this.micBtn.addClass('ai-chat-mic-rec'); setIcon(this.micBtn, 'square'); }
      new Notice('Запись… нажми микрофон ещё раз, чтобы остановить');
    } catch (e) { this.recognition = null; new Notice('Голосовой ввод недоступен'); }
  }

  loadImageFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      if (!this.pendingImages) this.pendingImages = [];
      this.pendingImages.push(reader.result);
      new Notice('Фото прикреплено 📷 (' + this.pendingImages.length + ')');
      if (this.imgIndicator) this.imgIndicator.setText('📷 прикреплено фото: ' + this.pendingImages.length + ' — напиши, что сделать, и отправь');
    };
    reader.readAsDataURL(file);
  }
  clearImages() { this.pendingImages = []; if (this.imgIndicator) this.imgIndicator.setText(''); }

  // Добавить фото (из галереи) в текущий рецепт как обложку
  addPhotoToNote(file) {
    const target = this.plugin.lastFile || this.app.workspace.getActiveFile();
    if (!target) { new Notice('Открой рецепт, чтобы добавить в него фото'); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const buf = reader.result;
        const ext = (file.name.match(/\.[a-zA-Z0-9]+$/) || ['.jpg'])[0];
        const folder = this.plugin.settings.recipesFolder ? this.plugin.settings.recipesFolder.replace(/\/+$/, '') : '';
        const attDir = (folder ? folder + '/' : '') + 'Вложения';
        if (!this.app.vault.getAbstractFileByPath(attDir)) { try { await this.app.vault.createFolder(attDir); } catch (e) {} }
        const base = target.basename.replace(/[\\/:*?"<>|#^\[\]]+/g, ' ').trim() || 'фото';
        let name = base + ext;
        let path = attDir + '/' + name; let n = 2;
        while (this.app.vault.getAbstractFileByPath(path)) { name = base + '-' + n + ext; path = attDir + '/' + name; n++; }
        await this.app.vault.createBinary(path, buf);
        let content = await this.app.vault.read(target);
        const embed = '![[' + name + ']]';
        const m = content.match(/^#\s+.+$/m);
        if (m) { const idx = content.indexOf(m[0]) + m[0].length; content = content.slice(0, idx) + '\n\n' + embed + content.slice(idx); }
        else { content = embed + '\n\n' + content; }
        await this.app.vault.modify(target, content);
        new Notice('Фото добавлено в «' + target.basename + '» 📷');
      } catch (e) {
        new Notice('Не удалось добавить фото: ' + (e && e.message ? e.message : e));
      }
    };
    reader.readAsArrayBuffer(file);
  }

  async onClose() { if (this.recognition) { try { this.recognition.stop(); } catch (e) {} } this.containerEl.children[1].empty(); }

  addBubble(role, text, withActions) {
    const wrap = this.messagesEl.createDiv('ai-msg ai-msg-' + role);
    const body = wrap.createDiv('ai-msg-body');
    if (role === 'assistant' && withActions) {
      MarkdownRenderer.renderMarkdown(text, body, '', this.plugin);
      const actions = wrap.createDiv('ai-msg-actions');
      actions.createEl('button', { text: 'Создать заметку' }).onclick = () => this.plugin.createRecipeNote(text);
      actions.createEl('button', { text: 'Заменить заметку' }).onclick = () => this.applyToNote(text);
      actions.createEl('button', { text: 'Копировать' }).onclick = () =>
        navigator.clipboard.writeText(text).then(() => new Notice('Скопировано'));
      actions.createEl('button', { text: 'Переименовать по заголовку' }).onclick = () =>
        this.plugin.renameToHeading(this.plugin.lastFile || this.app.workspace.getActiveFile());
    } else {
      body.setText(text);
      if (role === 'user') {
        wrap.addClass('ai-msg-clickable');
        // тап — вернуть текст в поле ввода (без уведомления)
        wrap.onclick = () => { this.inputEl.value = text; this.inputEl.focus(); };
        // долгое зажатие — скопировать в буфер (с уведомлением)
        let pressTimer = null;
        const startPress = () => { pressTimer = setTimeout(() => { navigator.clipboard.writeText(text).then(() => new Notice('Скопировано')); }, 500); };
        const cancelPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
        wrap.addEventListener('touchstart', startPress);
        wrap.addEventListener('touchend', cancelPress);
        wrap.addEventListener('touchmove', cancelPress);
        wrap.addEventListener('contextmenu', (e) => { e.preventDefault(); navigator.clipboard.writeText(text).then(() => new Notice('Скопировано')); });
      }
    }
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    return wrap;
  }

  async getActiveNoteText() {
    if (this.plugin.lastEditor) { const v = this.plugin.lastEditor.getValue(); if (v) return v; }
    const file = this.plugin.lastFile || this.app.workspace.getActiveFile();
    if (file) { try { return await this.app.vault.read(file); } catch (e) {} }
    return '';
  }

  async applyToNote(text) {
    const file = this.plugin.lastFile || this.app.workspace.getActiveFile();
    if (!file) { new Notice('Нет активной заметки'); return; }
    await this.app.vault.modify(file, text);
    this.plugin.openInBook(file);
    new Notice('Заметка обновлена ✅');
  }

  insertAtCursor(text) {
    if (!this.plugin.lastEditor) { new Notice('Открой заметку в редакторе'); return; }
    this.plugin.lastEditor.replaceSelection(text);
    new Notice('Вставлено ✅');
  }

  async send() {
    if (this.recognition) { this.voiceStopped = true; try { this.recognition.stop(); } catch (e) {} }
    const text = this.inputEl.value.trim();
    const imgs = (this.pendingImages && this.pendingImages.length) ? this.pendingImages.slice() : null;
    if (!text && !imgs) return;
    if (!this.plugin.settings.apiKey) { new Notice('Сначала вставь API-ключ в настройках плагина'); return; }
    this.inputEl.value = '';
    if (text) this.addBubble('user', text);
    if (imgs) this.addBubble('user', '📷 [фото: ' + imgs.length + ']');

    // Фото → распознать и заполнить шаблон
    if (imgs) { this.clearImages(); await this.recipeFromImage(text, imgs); return; }

    // Ссылка на сайт → прочитать рецепт со страницы
    const urlMatch = text.match(/https?:\/\/\S+/);
    if (urlMatch) { await this.recipeFromUrl(urlMatch[0], text.replace(urlMatch[0], '').trim()); return; }

    this.messages.push({ role: 'user', content: text });

    // Намерения распознаём прямо из текста — всё через чат, без модалок
    const wantsFolder = /(во всех|всех? рецепт|все рецепт|все заметк|всех заметк|кажд\w* рецепт|кажд\w* заметк|всю папку|по всей папке|все файлы)/i.test(text);
    const wantsRename = /(переименуй|переименов|название файла|имя файла|\brename\b)/i.test(text);
    const wantsNew = /(созда\w* рецепт|новый рецепт|запиши рецепт|добав\w* рецепт|напиши рецепт|состав\w* рецепт)/i.test(text);
    if (wantsFolder) { await this.batchPreview(text); return; }
    if (wantsRename) { await this.previewRename(); return; }
    if (wantsNew) { await this.recipeFromText(text); return; }

    // Текущий рецепт уходит ИИ ТОЛЬКО при явной ссылке на него
    // («исправь этот рецепт», «посмотри этот рецепт», «здесь» и т.п.).
    const refsNote = /(эт(от|у|ой|ом) (рецепт|заметк)|в этом рецепт|в этой заметк|исправь этот|посмотри этот|правь этот|глянь этот|\bздесь\b|\bсюда\b|\bтут\b)/i.test(text);
    const rf = this.plugin.settings.recipesFolder ? this.plugin.settings.recipesFolder.replace(/\/+$/, '') : '';
    const lf = this.plugin.lastFile;
    const recipeOpen = lf && (lf.parent ? lf.parent.path : '/') === rf;
    let noteText = '';
    if (recipeOpen && refsNote) {
      noteText = await this.getActiveNoteText();
    }

    // Содержимое заметки вшиваем прямо в последнее сообщение пользователя,
    // чтобы его учитывали даже слабые модели
    const apiMessages = [{ role: 'system', content: this.plugin.settings.systemPrompt }];
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i];
      const isLastUser = i === this.messages.length - 1 && m.role === 'user';
      if (isLastUser && noteText) {
        apiMessages.push({ role: 'user', content:
          m.content +
          '\n\n===== ТЕКУЩИЙ РЕЦЕПТ =====\n' + noteText + '\n===== КОНЕЦ РЕЦЕПТА =====\n\n' +
          'Если просят ИЗМЕНИТЬ этот рецепт — верни его ПОЛНЫЙ текст ДОСЛОВНО, символ в символ, ' +
          'внеся ТОЛЬКО запрошенную правку (например, добавив одну строку в список ингредиентов или поправив одно число). ' +
          'КАТЕГОРИЧЕСКИ нельзя переписывать, сокращать, переформулировать, менять оформление, метаданные, заголовок, картинки ![[...]] и незатронутые строки. ' +
          'Если это вопрос, а не правка — просто ответь текстом, не выводя рецепт.' });
      } else {
        apiMessages.push(m);
      }
    }

    const thinking = this.addBubble('assistant', 'думаю…');
    try {
      const reply = await this.plugin.callChat(apiMessages);
      this.messages.push({ role: 'assistant', content: reply });
      thinking.remove();
      this.addBubble('assistant', reply, true);
    } catch (e) {
      thinking.remove();
      this.addBubble('assistant', 'Ошибка: ' + (e && e.message ? e.message : String(e)));
      console.error('[AI Note Editor]', e);
    }
  }

  // Превью-переименование по заголовку (через чат, без немедленной перезаписи)
  async previewRename() {
    const file = this.plugin.lastFile || this.app.workspace.getActiveFile();
    if (!file) { this.addBubble('assistant', 'Нет активной заметки.'); return; }
    const content = await this.app.vault.read(file);
    const m = content.match(/^#\s+(.+)$/m);
    if (!m) { this.addBubble('assistant', 'В заметке нет заголовка «# ...» — не могу определить новое имя.'); return; }
    const title = m[1].trim();
    const wrap = this.messagesEl.createDiv('ai-msg ai-msg-assistant');
    wrap.createDiv('ai-msg-body').setText('Переименовать «' + file.basename + '» → «' + title + '»?');
    const actions = wrap.createDiv('ai-msg-actions');
    actions.createEl('button', { text: 'Переименовать' }).onclick = () => this.plugin.renameToHeading(file);
    actions.createEl('button', { text: 'Отмена' }).onclick = () => actions.setText('Отменено');
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  // Пузырь с готовым рецептом: создать новую заметку / заменить текущую / копировать
  addRecipeBubble(text) {
    const wrap = this.messagesEl.createDiv('ai-msg ai-msg-assistant');
    const body = wrap.createDiv('ai-msg-body');
    MarkdownRenderer.renderMarkdown(text, body, '', this.plugin);
    const actions = wrap.createDiv('ai-msg-actions');
    actions.createEl('button', { text: 'Создать заметку' }).onclick = () => this.plugin.createRecipeNote(text);
    actions.createEl('button', { text: 'Заменить текущую' }).onclick = () => this.applyToNote(text);
    actions.createEl('button', { text: 'Копировать' }).onclick = () =>
      navigator.clipboard.writeText(text).then(() => new Notice('Скопировано'));
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    return wrap;
  }

  // Сгенерировать рецепт по шаблону из текстового запроса
  async recipeFromText(request) {
    const instr = await this.plugin.recipePrompt(request);
    const thinking = this.addBubble('assistant', 'составляю рецепт по шаблону…');
    try {
      const reply = await this.plugin.callChat([
        { role: 'system', content: this.plugin.settings.systemPrompt },
        { role: 'user', content: instr }
      ]);
      const clean = reply.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
      thinking.remove();
      this.addRecipeBubble(clean);
    } catch (e) {
      thinking.remove();
      this.addBubble('assistant', 'Ошибка: ' + (e && e.message ? e.message : String(e)));
    }
  }

  // Распознать рецепт с фото (одного или нескольких) и заполнить шаблон (vision-модель)
  async recipeFromImage(request, images) {
    const list = Array.isArray(images) ? images : [images];
    const many = list.length > 1 ? ' На нескольких фото — один рецепт (разные страницы/ракурсы), объедини их.' : '';
    const instr = await this.plugin.recipePrompt((request ? ('распознай рецепт с фото. ' + request) : 'распознай рецепт с фото') + many);
    const thinking = this.addBubble('assistant', 'читаю фото и заполняю шаблон…');
    try {
      const userContent = [{ type: 'text', text: instr }];
      list.forEach((url) => userContent.push({ type: 'image_url', image_url: { url } }));
      const reply = await this.plugin.callChat(
        [ { role: 'system', content: this.plugin.settings.systemPrompt },
          { role: 'user', content: userContent } ],
        this.plugin.settings.visionModel
      );
      const clean = reply.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
      thinking.remove();
      this.addRecipeBubble(clean);
    } catch (e) {
      thinking.remove();
      this.addBubble('assistant', 'Ошибка распознавания: ' + (e && e.message ? e.message : String(e)) +
        '\nПроверь имя vision-модели в настройках (поле «Vision model»).');
    }
  }

  // Прочитать рецепт со страницы по ссылке и заполнить образец
  async recipeFromUrl(url, request) {
    const thinking = this.addBubble('assistant', 'читаю страницу…');
    try {
      const res = await requestUrl({ url, method: 'GET', throw: false });
      // Определяем кодировку (многие рус. сайты в windows-1251)
      const buf = res.arrayBuffer;
      let charset = 'utf-8';
      const ct = (res.headers && (res.headers['content-type'] || res.headers['Content-Type'])) || '';
      let cm = ct.match(/charset=([\w-]+)/i);
      if (!cm && buf) { const head = new TextDecoder('utf-8').decode(buf).slice(0, 3000); cm = head.match(/charset=["']?([\w-]+)/i); }
      if (cm) charset = cm[1].toLowerCase().replace(/^cp/, 'windows-');
      let html;
      try { html = new TextDecoder(charset).decode(buf); } catch (e) { html = res.text || ''; }
      let source = '';
      // сначала пробуем структурированные данные рецепта (JSON-LD)
      const blocks = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
      for (const b of blocks) {
        if (/recipe/i.test(b)) source += b.replace(/<\/?script[^>]*>/gi, '') + '\n';
      }
      if (!source) {
        source = html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
          .replace(/\s+/g, ' ').trim();
      }
      source = source.slice(0, 30000);
      if (!source) {
        thinking.remove();
        this.addBubble('assistant', 'Не удалось прочитать страницу (пусто). Попробуй скопировать текст рецепта вручную.');
        return;
      }
      const base = await this.plugin.recipePrompt('Извлеки рецепт с этой веб-страницы и заполни образец' + (request ? ('. ' + request) : ''));
      const full = base + '\n\n=====\nСОДЕРЖИМОЕ СТРАНИЦЫ (' + url + '):\n\n' + source;
      const reply = await this.plugin.callChat([
        { role: 'system', content: this.plugin.settings.systemPrompt },
        { role: 'user', content: full }
      ]);
      const clean = reply.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
      thinking.remove();
      this.addRecipeBubble(clean);
    } catch (e) {
      thinking.remove();
      this.addBubble('assistant', 'Не удалось загрузить страницу: ' + (e && e.message ? e.message : String(e)) +
        '\nНекоторые сайты блокируют доступ — тогда скопируй текст рецепта и вставь сюда.');
    }
  }

  // Пакетное превью по папке: показываем изменения, ничего не перезаписываем до «Применить»
  async batchPreview(instruction) {
    const active = this.plugin.lastFile || this.app.workspace.getActiveFile();
    const folderPath = active && active.parent ? active.parent.path : '/';
    const files = this.app.vault.getMarkdownFiles().filter((f) => (f.parent ? f.parent.path : '/') === folderPath);
    if (files.length === 0) { this.addBubble('assistant', 'В папке нет заметок.'); return; }

    const info = this.addBubble('assistant', 'Готовлю превью для ' + files.length + ' заметок из «' + folderPath + '». Ничего не перезаписываю — покажу изменения.');
    const infoBody = info.querySelector('.ai-msg-body');
    const results = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (infoBody) infoBody.setText('Обрабатываю ' + (i + 1) + '/' + files.length + ': ' + file.basename + '…');
      try {
        const content = await this.app.vault.read(file);
        const reply = await this.plugin.callChat([
          { role: 'system', content: this.plugin.settings.systemPrompt },
          { role: 'user', content: instruction + '\n\n---\nЗаметка (верни ТОЛЬКО полный обновлённый текст заметки, без пояснений и без тройных кавычек):\n\n' + content }
        ]);
        const clean = reply.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
        results.push({ file, clean });
      } catch (e) {
        results.push({ file, error: e && e.message ? e.message : String(e) });
      }
      if (i < files.length - 1) await new Promise((r) => setTimeout(r, 2500));
    }
    info.remove();

    const head = this.addBubble('assistant', 'Готово превью по ' + results.length + ' заметкам. Проверь и применяй по одной или все сразу:');
    const headActions = head.createDiv('ai-msg-actions');
    headActions.createEl('button', { text: 'Применить все' }).onclick = async () => {
      let n = 0;
      for (const r of results) { if (r.clean) { await this.app.vault.modify(r.file, r.clean); n++; } }
      new Notice('Применено к ' + n + ' заметкам ✅');
    };

    for (const r of results) {
      const wrap = this.messagesEl.createDiv('ai-msg ai-msg-assistant');
      wrap.createEl('div', { cls: 'ai-msg-file', text: '📄 ' + r.file.basename });
      const body = wrap.createDiv('ai-msg-body');
      if (r.error) { body.setText('Ошибка: ' + r.error); continue; }
      MarkdownRenderer.renderMarkdown(r.clean, body, r.file.path, this.plugin);
      const actions = wrap.createDiv('ai-msg-actions');
      actions.createEl('button', { text: 'Применить' }).onclick = async () => {
        await this.app.vault.modify(r.file, r.clean);
        new Notice('Применено: ' + r.file.basename);
      };
    }
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }
}

/* ─────────────── Книга рецептов (галерея) ─────────────── */
class GalleryView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.filterCat = null; this.filterTag = null; this.filterRating = null; this.filterCooked = null; }
  getViewType() { return VIEW_TYPE_GALLERY; }
  getDisplayText() { return 'Книга рецептов'; }
  getIcon() { return 'book-open'; }

  async onOpen() { this.plugin.bookLeaf = this.leaf; this.render(); }
  async onClose() { this.containerEl.children[1].empty(); }

  colorFor(name) {
    const palette = ['#7a5a2e', '#3f6b52', '#4a5a8a', '#8a4a4a', '#6b6b3a', '#4a6b6b', '#7a4a6b'];
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
  }

  createRecipe() {
    new NewRecipeModal(this.app, this.plugin, (opts) => this.createBlank(opts)).open();
  }

  async createBlank(opts) {
    opts = opts || {};
    const title = (opts.title || 'Новый рецепт').trim() || 'Новый рецепт';
    const cat = opts.cat || '';
    const tags = opts.tags || [];
    let fm = '---\nкатегория: ' + cat + '\n';
    if (tags.length) { fm += 'теги:\n' + tags.map((t) => '  - ' + t).join('\n') + '\n'; } else { fm += 'теги: \n'; }
    fm += 'время_мин: \nпорции: \nоценка: \n---';
    const content = fm + '\n\n# ' + title + '\n\n**Ингредиенты**\n\n- [ ] \n\n**Приготовление**\n\n1. \n\n**Калории**\n\n';
    const file = await this.plugin.createRecipeFile(content);
    if (file) this.leaf.openFile(file);
  }

  render() {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass('recipe-gallery');

    const folder = this.plugin.settings.recipesFolder ? this.plugin.settings.recipesFolder.replace(/\/+$/, '') : '';
    const skip = [this.plugin.settings.templatePath, this.plugin.settings.examplePath];
    const info = this.app.vault.getMarkdownFiles()
      .filter((f) => (f.parent ? f.parent.path : '/') === folder && skip.indexOf(f.path) === -1)
      .sort((a, b) => a.basename.localeCompare(b.basename, 'ru'))
      .map((f) => {
        const fm = (this.app.metadataCache.getFileCache(f) || {}).frontmatter || {};
        let tags = fm['теги']; if (typeof tags === 'string') tags = [tags];
        return { file: f, cat: fm['категория'] ? String(fm['категория']) : null, tags: (tags || []).map(String), rating: parseInt(fm['оценка']) || null, cooked: fm['приготовлено'] === true };
      });

    const header = root.createDiv('rg-header');
    header.createEl('div', { cls: 'rg-title', text: '📖 Книга рецептов' });
    header.createEl('button', { cls: 'rg-refresh', text: '⟳' }).onclick = () => this.render();

    // действия
    const actions = root.createDiv('rg-actions');
    actions.createEl('button', { cls: 'rg-create', text: '＋ Создать рецепт' }).onclick = () => this.createRecipe();
    actions.createEl('button', { cls: 'rg-chat', text: '🍳 Поварёнок' }).onclick = () => this.plugin.activateView();

    // фильтры по свойствам
    const predefCats = (this.plugin.settings.categoriesList || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
    const predefTags = (this.plugin.settings.tagsList || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
    const cats = Array.from(new Set(predefCats.concat(info.map((i) => i.cat).filter(Boolean))));
    const tags = Array.from(new Set(predefTags.concat([].concat.apply([], info.map((i) => i.tags)))));
    const rates = [5, 4, 3, 2, 1];
    if (cats.length || tags.length || rates.length) {
      const fbar = root.createDiv('rg-filters');
      const group = (label, items) => {
        if (!items.length) return;
        const g = fbar.createDiv('rg-fgroup');
        g.createEl('span', { cls: 'rg-flabel', text: label });
        items.forEach((it) => { const c = g.createEl('span', { cls: 'rg-chip' + (it.active ? ' rg-chip-active' : ''), text: it.label }); c.onclick = it.on; });
      };
      group('Категория', cats.map((c) => ({ label: c, active: this.filterCat === c, on: () => { this.filterCat = this.filterCat === c ? null : c; this.render(); } })));
      group('Оценка', rates.map((r) => ({ label: '★'.repeat(r), active: this.filterRating === r, on: () => { this.filterRating = this.filterRating === r ? null : r; this.render(); } })));
      group('Готовка', [
        { label: '✅ Приготовленные', active: this.filterCooked === true, on: () => { this.filterCooked = this.filterCooked === true ? null : true; this.render(); } },
        { label: '🍳 Ещё не приготовленные', active: this.filterCooked === false, on: () => { this.filterCooked = this.filterCooked === false ? null : false; this.render(); } }
      ]);
      if (this.filterCat || this.filterTag || this.filterRating || this.filterCooked !== null) {
        const g = fbar.createDiv('rg-fgroup');
        g.createEl('span', { cls: 'rg-chip rg-chip-reset', text: '✕ сбросить' }).onclick = () => { this.filterCat = null; this.filterTag = null; this.filterRating = null; this.filterCooked = null; this.render(); };
      }
    }

    let shown = info;
    if (this.filterCat) shown = shown.filter((i) => i.cat === this.filterCat);
    if (this.filterTag) shown = shown.filter((i) => i.tags.indexOf(this.filterTag) !== -1);
    if (this.filterRating) shown = shown.filter((i) => i.rating === this.filterRating);
    if (this.filterCooked !== null) shown = shown.filter((i) => i.cooked === this.filterCooked);

    const grid = root.createDiv('rg-grid');
    if (shown.length === 0) { grid.createEl('div', { cls: 'rg-empty', text: 'Ничего не найдено.' }); return; }

    for (const it of shown) {
      const file = it.file;
      const cache = this.app.metadataCache.getFileCache(file) || {};
      const fm = cache.frontmatter || {};
      const card = grid.createDiv('rg-card');
      card.onclick = () => this.leaf.openFile(file);

      let imgUrl = null;
      const emb = (cache.embeds || []).find((e) => /\.(png|jpe?g|webp|gif)$/i.test(e.link));
      if (emb) {
        const dest = this.app.metadataCache.getFirstLinkpathDest(emb.link, file.path);
        if (dest) imgUrl = this.app.vault.getResourcePath(dest);
      }
      if (imgUrl) { const cover = card.createDiv('rg-cover'); cover.style.backgroundImage = 'url("' + imgUrl + '")'; }

      const body = card.createDiv('rg-body');
      body.createEl('div', { cls: 'rg-name', text: '🍽 ' + file.basename });

      const pills = body.createDiv('rg-pills');
      if (it.cat) { const s = pills.createEl('span', { cls: 'rg-pill', text: it.cat }); s.style.background = this.colorFor(it.cat); }
      it.tags.forEach((t) => { const s = pills.createEl('span', { cls: 'rg-pill', text: t }); s.style.background = this.colorFor(t); });

      const meta = body.createDiv('rg-meta');
      if (fm['время_мин']) meta.createEl('span', { cls: 'rg-time', text: '⏱ ' + fm['время_мин'] + ' мин' });
      const r = parseInt(fm['оценка']);
      if (r > 0) meta.createEl('span', { cls: 'rg-stars', text: '★★★★★'.slice(0, r) });

      const cookBtn = card.createEl('button', { cls: 'rg-cooked' });
      const paintCook = () => { cookBtn.setText(it.cooked ? '✅' : '◯'); cookBtn.toggleClass('rg-cooked-on', it.cooked); cookBtn.setAttr('title', it.cooked ? 'Приготовлено' : 'Отметить приготовленным'); };
      paintCook();
      cookBtn.onclick = async (e) => {
        e.stopPropagation();
        it.cooked = !it.cooked;
        paintCook();
        try { await this.app.fileManager.processFrontMatter(file, (f) => { f['приготовлено'] = it.cooked; }); } catch (err) {}
      };
    }
    root.createDiv({ cls: 'rg-spacer', attr: { style: 'height: 160px; flex: 0 0 auto;' } });
  }
}

/* ─────────────── Выбор способа создания ─────────────── */
class CreateModal extends Modal {
  constructor(app, onManual, onAI) { super(app); this.onManual = onManual; this.onAI = onAI; }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Новый рецепт' });
    const b1 = contentEl.createEl('button', { cls: 'mod-cta pm-full', text: '✍️ Написать самой' });
    b1.onclick = () => { this.close(); this.onManual(); };
    const b2 = contentEl.createEl('button', { cls: 'pm-full', text: '🤖 Составить с ИИ' });
    b2.onclick = () => { this.close(); this.onAI(); };
  }
  onClose() { this.contentEl.empty(); }
}

/* ─────────────── Редактор свойств карточки ─────────────── */
class PropsModal extends Modal {
  constructor(app, plugin, file, onSave) { super(app); this.plugin = plugin; this.file = file; this.onSave = onSave; }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Свойства: ' + this.file.basename });
    const fm = (this.app.metadataCache.getFileCache(this.file) || {}).frontmatter || {};
    this.cat = fm['категория'] ? String(fm['категория']) : '';
    let ct = fm['теги']; if (typeof ct === 'string') ct = [ct];
    this.tags = (ct || []).map(String);
    this.rating = parseInt(fm['оценка']) || 0;
    this.time = fm['время_мин'] != null ? String(fm['время_мин']) : '';
    this.portions = fm['порции'] != null ? String(fm['порции']) : '';

    contentEl.createEl('div', { cls: 'pm-label', text: 'Категория' });
    const catSel = contentEl.createEl('select', { cls: 'pm-select' });
    const cats = (this.plugin.settings.categoriesList || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
    if (this.cat && cats.indexOf(this.cat) === -1) cats.unshift(this.cat);
    catSel.createEl('option', { text: '— не выбрано —', value: '' });
    cats.forEach((c) => { const o = catSel.createEl('option', { text: c, value: c }); if (c === this.cat) o.selected = true; });
    catSel.onchange = () => { this.cat = catSel.value; };

    contentEl.createEl('div', { cls: 'pm-label', text: 'Теги' });
    const tagBox = contentEl.createDiv('pm-tags');
    const allTags = (this.plugin.settings.tagsList || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
    this.tags.forEach((t) => { if (allTags.indexOf(t) === -1) allTags.push(t); });
    allTags.forEach((t) => {
      const lbl = tagBox.createEl('label', { cls: 'pm-chk' });
      const cb = lbl.createEl('input', { type: 'checkbox' }); cb.checked = this.tags.indexOf(t) !== -1;
      lbl.appendText(' ' + t);
      cb.onchange = () => { if (cb.checked) { if (this.tags.indexOf(t) === -1) this.tags.push(t); } else { this.tags = this.tags.filter((x) => x !== t); } };
    });

    contentEl.createEl('div', { cls: 'pm-label', text: 'Оценка' });
    const stars = contentEl.createDiv('pm-stars');
    const draw = () => { stars.empty(); for (let i = 1; i <= 5; i++) { const s = stars.createEl('span', { cls: 'pm-star' + (i <= this.rating ? ' pm-star-on' : ''), text: '★' }); s.onclick = () => { this.rating = this.rating === i ? 0 : i; draw(); }; } };
    draw();

    contentEl.createEl('div', { cls: 'pm-label', text: 'Время (мин) / порции' });
    const row = contentEl.createDiv('pm-row');
    const timeI = row.createEl('input', { type: 'number', attr: { placeholder: 'мин' } }); timeI.value = this.time; timeI.onchange = () => { this.time = timeI.value; };
    const portI = row.createEl('input', { type: 'number', attr: { placeholder: 'порции' } }); portI.value = this.portions; portI.onchange = () => { this.portions = portI.value; };

    const save = contentEl.createEl('button', { cls: 'mod-cta pm-full', text: 'Сохранить' });
    save.onclick = async () => {
      try {
        await this.app.fileManager.processFrontMatter(this.file, (f) => {
          if (this.cat) f['категория'] = this.cat; else delete f['категория'];
          if (this.tags.length) f['теги'] = this.tags; else delete f['теги'];
          if (this.rating) f['оценка'] = this.rating; else delete f['оценка'];
          if (this.time !== '') f['время_мин'] = Number(this.time); else delete f['время_мин'];
          if (this.portions !== '') f['порции'] = Number(this.portions); else delete f['порции'];
        });
        new Notice('Свойства сохранены ✅');
      } catch (e) { new Notice('Ошибка: ' + (e && e.message ? e.message : e)); }
      this.close();
      if (this.onSave) this.onSave();
    };
  }
  onClose() { this.contentEl.empty(); }
}

/* ─────────────── Новый рецепт: название, категория, теги ─────────────── */
class NewRecipeModal extends Modal {
  constructor(app, plugin, onCreate) { super(app); this.plugin = plugin; this.onCreate = onCreate; this.rTitle = ''; this.cat = ''; this.tags = []; }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Новый рецепт' });

    contentEl.createEl('div', { cls: 'pm-label', text: 'Название' });
    const titleI = contentEl.createEl('input', { type: 'text', attr: { placeholder: 'Например, Борщ', style: 'width:100%' } });
    titleI.oninput = () => { this.rTitle = titleI.value; };

    contentEl.createEl('div', { cls: 'pm-label', text: 'Категория' });
    const sel = contentEl.createEl('select', { cls: 'pm-select' });
    sel.createEl('option', { text: '— не выбрано —', value: '' });
    (this.plugin.settings.categoriesList || '').split(/\n+/).map((s) => s.trim()).filter(Boolean)
      .forEach((c) => sel.createEl('option', { text: c, value: c }));
    sel.onchange = () => { this.cat = sel.value; };

    contentEl.createEl('div', { cls: 'pm-label', text: 'Теги' });
    const tagBox = contentEl.createDiv('pm-tags');
    (this.plugin.settings.tagsList || '').split(/\n+/).map((s) => s.trim()).filter(Boolean)
      .forEach((t) => {
        const lbl = tagBox.createEl('label', { cls: 'pm-chk' });
        const cb = lbl.createEl('input', { type: 'checkbox' });
        lbl.appendText(' ' + t);
        cb.onchange = () => { if (cb.checked) { this.tags.push(t); } else { this.tags = this.tags.filter((x) => x !== t); } };
      });

    const btn = contentEl.createEl('button', { cls: 'mod-cta pm-full', text: 'Создать' });
    btn.onclick = () => { this.close(); this.onCreate({ title: this.rTitle, cat: this.cat, tags: this.tags }); };
  }
  onClose() { this.contentEl.empty(); }
}

/* ─────────────── Плагин ─────────────── */
module.exports = class AINoteEditor extends Plugin {
  async onload() {
    await this.loadSettings();

    this.lastEditor = null;
    this.lastFile = null;
    this.bookLeaf = null;
    this.onGallery = false;
    const remember = (leaf) => {
      const v = leaf && leaf.view;
      const t = v && v.getViewType && v.getViewType();
      if (t === 'markdown') {
        this.lastEditor = v.editor;
        this.lastFile = v.file;
        this.onGallery = false;
      } else if (t === VIEW_TYPE_GALLERY) {
        this.onGallery = true;
      }
    };
    this.registerEvent(this.app.workspace.on('active-leaf-change', remember));
    this.registerEvent(this.app.workspace.on('file-open', (file) => { if (file) this.lastFile = file; }));
    this.app.workspace.onLayoutReady(() => {
      remember(this.app.workspace.activeLeaf);
      const f = this.app.workspace.getActiveFile();
      if (f) this.lastFile = f;
      // Любая новая ПУСТАЯ заметка в папке рецептов становится рецептом-заготовкой
      this.registerEvent(this.app.vault.on('create', (file) => this.onRecipeFileCreated(file)));
    });

    this.registerView(VIEW_TYPE, (leaf) => new ChatView(leaf, this));
    this.addRibbonIcon('chef-hat', 'Поварёнок', () => this.activateView());

    this.registerView(VIEW_TYPE_GALLERY, (leaf) => new GalleryView(leaf, this));
    this.addRibbonIcon('book-open', 'Книга рецептов', () => this.activateGallery());

    this.addCommand({ id: 'open-ai-chat', name: 'Открыть Поварёнка', callback: () => this.activateView() });
    this.addCommand({ id: 'open-recipe-gallery', name: 'Открыть книгу рецептов', callback: () => this.activateGallery() });

    this.addCommand({
      id: 'ai-format-recipe',
      name: 'ИИ: причесать рецепт (формат + орфография)',
      icon: 'wand-2',
      editorCallback: (editor) => this.runQuickEdit(editor)
    });

    this.addCommand({
      id: 'ai-calc-calories',
      name: 'ИИ: посчитать калории',
      icon: 'flame',
      editorCallback: (editor) => this.runCalcCalories(editor)
    });

    this.addCommand({
      id: 'ai-rename-to-heading',
      name: 'ИИ: переименовать файл по заголовку (H1)',
      callback: () => {
        const f = this.lastFile || this.app.workspace.getActiveFile();
        if (f) this.renameToHeading(f); else new Notice('Нет активной заметки');
      }
    });

    this.addCommand({
      id: 'insert-photo-from-gallery',
      name: 'Вставить фото из галереи (в рецепт)',
      icon: 'image-plus',
      editorCallback: (editor) => this.insertPhotoFromGallery(editor)
    });

    this.addSettingTab(new AISettingTab(this.app, this));

    // Авто-открытие книги — после регистрации вью
    this.app.workspace.onLayoutReady(() => { if (this.settings.openBookOnStart) this.activateGallery(); });
  }

  onunload() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((l) => l.detach());
    this.app.workspace.getLeavesOfType(VIEW_TYPE_GALLERY).forEach((l) => l.detach());
  }

  async openChatWith(prompt) {
    await this.activateView();
    setTimeout(() => {
      const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
      const v = leaf && leaf.view;
      if (v && v.inputEl) { v.inputEl.value = prompt; v.inputEl.focus(); }
    }, 80);
  }

  isLeafAlive(leaf) {
    if (!leaf) return false;
    let alive = false;
    this.app.workspace.iterateAllLeaves((l) => { if (l === leaf) alive = true; });
    return alive;
  }

  // Открыть рецепт в «книжной» вкладке — чтобы «Назад» возвращал к книге
  openInBook(file) {
    const leaf = this.isLeafAlive(this.bookLeaf) ? this.bookLeaf : this.app.workspace.getLeaf(false);
    leaf.openFile(file);
    this.app.workspace.revealLeaf(leaf);
    // на телефоне свернём боковую панель с чатом, чтобы показать саму заметку
    if (this.app.isMobile) {
      const rs = this.app.workspace.rightSplit;
      if (rs && rs.collapse) rs.collapse();
    }
  }

  async activateGallery() {
    // Переиспользуем «книжную» вкладку, даже если в ней сейчас открыт рецепт
    if (this.isLeafAlive(this.bookLeaf)) {
      if (!this.bookLeaf.view || this.bookLeaf.view.getViewType() !== VIEW_TYPE_GALLERY) {
        await this.bookLeaf.setViewState({ type: VIEW_TYPE_GALLERY, active: true });
      }
      this.app.workspace.revealLeaf(this.bookLeaf);
      return;
    }
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_GALLERY);
    if (existing.length) { this.bookLeaf = existing[0]; this.app.workspace.revealLeaf(existing[0]); return; }
    const leaf = this.app.workspace.getLeaf(true);
    this.bookLeaf = leaf;
    await leaf.setViewState({ type: VIEW_TYPE_GALLERY, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async runQuickEdit(editor) {
    if (!this.settings.apiKey) { new Notice('Сначала вставь API-ключ в настройках плагина'); return; }
    const src = editor.somethingSelected() ? editor.getSelection() : editor.getValue();
    const example = await this.loadExample();
    const notice = new Notice('ИИ приводит рецепт к образцу…', 0);
    try {
      let prompt = 'Приведи рецепт СТРОГО к формату образца: тот же блок метаданных между ---, ' +
        'заголовок # Название, раздел «Ингредиенты» — список с чекбоксами (КАЖДАЯ строка начинается ровно с "- [ ] "), ' +
        'раздел «Приготовление» — нумерованный список, в том же порядке. ' +
        'Исправь орфографические ошибки. НЕ меняй сами ингредиенты, их количества и шаги — только оформление, порядок полей и ошибки. ' +
        'ОБЯЗАТЕЛЬНО сохрани существующие строки с картинками ![[...]] на своих местах без изменений. Новых картинок не выдумывай.';
      if (example) prompt += '\n\nОБРАЗЕЦ ФОРМАТА (бери из него ТОЛЬКО оформление, не содержимое):\n\n' + example;
      prompt += '\n\nРЕЦЕПТ ДЛЯ ОФОРМЛЕНИЯ:\n\n"""\n' + src + '\n"""\n\nВерни ТОЛЬКО итоговый рецепт, без пояснений и без тройных кавычек.';
      const reply = await this.callChat([
        { role: 'system', content: this.settings.systemPrompt },
        { role: 'user', content: prompt }
      ]);
      const clean = reply.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
      if (editor.somethingSelected()) editor.replaceSelection(clean); else editor.setValue(clean);
      notice.hide();
      new Notice('Готово ✅');
    } catch (e) {
      notice.hide();
      new Notice('Ошибка: ' + (e && e.message ? e.message : String(e)), 8000);
    }
  }

  // Посчитать калории по ингредиентам и вписать раздел «Калории»
  async runCalcCalories(editor) {
    if (!this.settings.apiKey) { new Notice('Сначала вставь API-ключ в настройках плагина'); return; }
    const src = editor.getValue();
    const notice = new Notice('ИИ считает калории…', 0);
    try {
      const reply = await this.callChat([
        { role: 'system', content: this.settings.systemPrompt },
        { role: 'user', content:
          'Посчитай примерную калорийность рецепта ниже по его ингредиентам. ' +
          'Верни ПОЛНЫЙ текст рецепта ДОСЛОВНО, добавив или обновив ТОЛЬКО раздел «**Калории**» в конце (после «Приготовление»): ' +
          'выпиши калорийность КАЖДОГО ингредиента отдельной строкой (например «- Мука — 1020 ккал»), затем итоговую строку «Всего: N ккал». ' +
          'Без пояснений. Всё остальное сохрани без изменений.\n\n"""\n' +
          src + '\n"""\n\nВерни только итоговый текст рецепта, без пояснений и без тройных кавычек.' }
      ]);
      const clean = reply.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
      editor.setValue(clean);
      notice.hide();
      new Notice('Калории посчитаны ✅');
    } catch (e) {
      notice.hide();
      new Notice('Ошибка: ' + (e && e.message ? e.message : String(e)), 8000);
    }
  }

  // Переименовать файл, чтобы имя совпало с первым заголовком # H1
  async renameToHeading(file) {
    if (!file) { new Notice('Нет активной заметки'); return false; }
    let content = '';
    try { content = await this.app.vault.read(file); } catch (e) { new Notice('Не удалось прочитать заметку'); return false; }
    const m = content.match(/^#\s+(.+)$/m);
    if (!m) { new Notice('В заметке нет заголовка «# ...»'); return false; }
    let title = m[1].trim().replace(/[\\/:*?"<>|#^\[\]]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!title) { new Notice('Пустой заголовок'); return false; }
    const dir = file.parent && file.parent.path && file.parent.path !== '/' ? file.parent.path + '/' : '';
    const newPath = dir + title + '.' + file.extension;
    if (newPath === file.path) { new Notice('Имя уже совпадает с заголовком'); return true; }
    try {
      await this.app.fileManager.renameFile(file, newPath);
      new Notice('Переименовано → ' + title);
      return true;
    } catch (e) {
      new Notice('Не удалось переименовать: ' + (e && e.message ? e.message : e));
      return false;
    }
  }

  // Прочитать шаблон рецепта (или вернуть запасной)
  async loadTemplate() {
    const p = this.settings.templatePath;
    const f = p ? this.app.vault.getAbstractFileByPath(p) : null;
    if (f) { try { return await this.app.vault.read(f); } catch (e) {} }
    return '';
  }

  // Взять один существующий рецепт как образец формата (не сам шаблон)
  async loadExample() {
    const ex = this.settings.examplePath ? this.app.vault.getAbstractFileByPath(this.settings.examplePath) : null;
    if (ex) { try { return await this.app.vault.read(ex); } catch (e) {} }
    const folder = this.settings.recipesFolder ? this.settings.recipesFolder.replace(/\/+$/, '') : '';
    const tplPath = this.settings.templatePath;
    const files = this.app.vault.getMarkdownFiles()
      .filter((f) => (f.parent ? f.parent.path : '/') === folder && f.path !== tplPath);
    if (files.length === 0) return '';
    try { return await this.app.vault.read(files[0]); } catch (e) { return ''; }
  }

  // Собрать строгий промпт: шаблон + пример заполненного рецепта + задание
  async recipePrompt(request) {
    const tpl = await this.loadTemplate();
    const example = await this.loadExample();
    let p = 'Ты создаёшь рецепт СТРОГО в формате моей книги рецептов в Obsidian.\n\n';
    if (tpl) p += 'ШАБЛОН — обязательная структура (те же заголовки, поля и порядок; блок метаданных между --- сохрани с теми же ключами):\n\n' + tpl + '\n\n=====\n';
    if (example) p += 'ПРИМЕР — ТОЛЬКО образец ОФОРМЛЕНИЯ (структура, поля, стиль). НЕ бери из него ингредиенты, количества и шаги:\n\n' + example + '\n\n=====\n';
    p += 'ЗАДАНИЕ: ' + (request || 'заполни по фото') +
      '\n\nПравила: повтори из примера ТОЛЬКО оформление (блок метаданных между ---, затем # Название, разделы «Ингредиенты» и «Приготовление»). ' +
      'Ингредиенты, количества и шаги бери СТРОГО из источника задания (страница/фото/текст), а НЕ из примера. ' +
      'Если в источнике рецепта нет или он нечитаем — ответь ровно «Не удалось извлечь рецепт» и ничего не выдумывай. ' +
      'Обязательно добавь раздел «**Калории**»: выпиши калорийность КАЖДОГО ингредиента отдельной строкой (например «- Мука — 1020 ккал»), затем итог «Всего: N ккал». ' +
      'Не добавляй строки с картинками ![[...]], если их нет. ' +
      'Верни ТОЛЬКО готовый рецепт в этом формате, без пояснений и без тройных кавычек.';
    return p;
  }

  // Создать новую заметку-рецепт (имя = заголовок # H1)
  // Новая пустая заметка: в папке рецептов ИЛИ созданная при открытой книге → делаем рецептом
  async onRecipeFileCreated(file) {
    try {
      if (!file || !file.path || !file.path.endsWith('.md')) return;
      if (file.path === this.settings.templatePath || file.path === this.settings.examplePath) return;
      const folder = this.settings.recipesFolder ? this.settings.recipesFolder.replace(/\/+$/, '') : '';
      const inRecipes = (file.parent ? file.parent.path : '/') === folder;

      // «создана из книги» определяем синхронно, ДО задержки (потом активная вкладка сменится на заметку)
      const av = this.app.workspace.activeLeaf && this.app.workspace.activeLeaf.view;
      const activeType = av && av.getViewType && av.getViewType();
      const fromBook = this.onGallery === true || activeType === VIEW_TYPE_GALLERY;

      if (!inRecipes && !fromBook) return; // не рецепт и не из книги — не трогаем

      await new Promise((r) => setTimeout(r, 60));
      const content = await this.app.vault.read(file);
      if (content && content.trim().length > 0) return; // не пустая — не трогаем

      // если создана из книги, но не в папке рецептов — переносим в неё
      if (!inRecipes && fromBook && folder) {
        if (!this.app.vault.getAbstractFileByPath(folder)) { try { await this.app.vault.createFolder(folder); } catch (e) {} }
        let newPath = folder + '/' + file.name;
        let n = 2;
        while (this.app.vault.getAbstractFileByPath(newPath)) { newPath = folder + '/' + file.basename + ' ' + n + '.md'; n++; }
        try { await this.app.fileManager.renameFile(file, newPath); } catch (e) {}
      }

      const title = file.basename || 'Новый рецепт';
      const tpl = '---\nкатегория: \nтеги: \nвремя_мин: \nпорции: \nоценка: \n---\n\n# ' + title +
        '\n\n**Ингредиенты**\n\n- [ ] \n\n**Приготовление**\n\n1. \n\n**Калории**\n\n';
      await this.app.vault.modify(file, tpl);
    } catch (e) {}
  }

  async createRecipeFile(text) {
    const m = text.match(/^#\s+(.+)$/m);
    let title = (m ? m[1] : 'Новый рецепт').replace(/[\\/:*?"<>|#^\[\]]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Новый рецепт';
    const folder = this.settings.recipesFolder ? this.settings.recipesFolder.replace(/\/+$/, '') : '';
    if (folder && !this.app.vault.getAbstractFileByPath(folder)) { try { await this.app.vault.createFolder(folder); } catch (e) {} }
    let path = (folder ? folder + '/' : '') + title + '.md';
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(path)) { path = (folder ? folder + '/' : '') + title + ' ' + n + '.md'; n++; }
    try {
      const file = await this.app.vault.create(path, text);
      new Notice('Создан рецепт: ' + file.basename);
      return file;
    } catch (e) {
      new Notice('Не удалось создать заметку: ' + (e && e.message ? e.message : e));
      return null;
    }
  }

  async createRecipeNote(text) {
    const file = await this.createRecipeFile(text);
    if (file) this.openInBook(file);
    return file;
  }

  // Вставить фото из галереи в позицию курсора текущего рецепта
  insertPhotoFromGallery(editor) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const buf = reader.result;
          const ext = (file.name.match(/\.[a-zA-Z0-9]+$/) || ['.jpg'])[0];
          const active = this.app.workspace.getActiveFile();
          const folder = this.settings.recipesFolder ? this.settings.recipesFolder.replace(/\/+$/, '') : '';
          const attDir = (folder ? folder + '/' : '') + 'Вложения';
          if (!this.app.vault.getAbstractFileByPath(attDir)) { try { await this.app.vault.createFolder(attDir); } catch (e) {} }
          const base = (active ? active.basename : 'фото').replace(/[\\/:*?"<>|#^\[\]]+/g, ' ').trim() || 'фото';
          let name = base + ext;
          let path = attDir + '/' + name; let n = 2;
          while (this.app.vault.getAbstractFileByPath(path)) { name = base + '-' + n + ext; path = attDir + '/' + name; n++; }
          await this.app.vault.createBinary(path, buf);
          editor.replaceSelection('![[' + name + ']]\n');
          new Notice('Фото вставлено 📷');
        } catch (e) {
          new Notice('Не удалось вставить фото: ' + (e && e.message ? e.message : e));
        }
      };
      reader.readAsArrayBuffer(file);
    };
    input.click();
  }

  parseModels() {
    return (this.settings.models || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  }

  // Пробуем модели по порядку: если одна занята (429) или падает — берём следующую
  async callChat(messages, modelOverride) {
    const models = modelOverride ? [modelOverride] : this.parseModels();
    if (models.length === 0) throw new Error('Не задана ни одна модель в настройках');
    let lastErr = null;
    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      try {
        const res = await requestUrl({
          url: this.settings.baseUrl.replace(/\/+$/, '') + '/chat/completions',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + this.settings.apiKey
          },
          body: JSON.stringify({ model, messages }),
          throw: false
        });
        const errCode = res.json && res.json.error ? res.json.error.code : null;
        const busy = res.status === 429 || res.status >= 500 || errCode === 429;
        if (busy) {
          lastErr = new Error('429 / занята: ' + model);
          if (i < models.length - 1) new Notice('«' + model + '» занята, пробую следующую…', 2500);
          continue;
        }
        if (res.status < 200 || res.status >= 300 || (res.json && res.json.error)) {
          const detail = res.json && res.json.error ? JSON.stringify(res.json.error) : res.text;
          throw new Error(res.status + ' ' + detail);
        }
        return res.json.choices[0].message.content.trim();
      } catch (e) {
        lastErr = e;
        if (i < models.length - 1) { new Notice('«' + model + '» недоступна, пробую следующую…', 2500); continue; }
      }
    }
    throw lastErr || new Error('Все модели недоступны');
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (this.settings.model && !this.settings.models) this.settings.models = this.settings.model;
  }
  async saveSettings() { await this.saveData(this.settings); }
};

/* ─────────────── Настройки ─────────────── */
class AISettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'AI Note Editor' });

    new Setting(containerEl).setName('API Base URL')
      .setDesc('OpenAI-совместимый эндпоинт. По умолчанию Groq.')
      .addText((t) => t.setValue(this.plugin.settings.baseUrl)
        .onChange(async (v) => { this.plugin.settings.baseUrl = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName('API Key')
      .setDesc('Ключ Groq (gsk_...) или другого провайдера.')
      .addText((t) => { t.setValue(this.plugin.settings.apiKey)
        .onChange(async (v) => { this.plugin.settings.apiKey = v; await this.plugin.saveSettings(); });
        t.inputEl.type = 'password'; });

    new Setting(containerEl).setName('Models (по одной на строку)')
      .setDesc('Пробуются по порядку: если модель занята (429) — берётся следующая.')
      .addTextArea((t) => { t.setValue(this.plugin.settings.models)
        .onChange(async (v) => { this.plugin.settings.models = v; await this.plugin.saveSettings(); });
        t.inputEl.rows = 4; t.inputEl.style.width = '100%'; });

    new Setting(containerEl).setName('Vision model')
      .setDesc('Модель для распознавания фото (Groq: напр. meta-llama/llama-4-scout-17b-16e-instruct).')
      .addText((t) => t.setValue(this.plugin.settings.visionModel)
        .onChange(async (v) => { this.plugin.settings.visionModel = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName('Путь к шаблону рецепта')
      .setDesc('Заметка-шаблон, по которой ИИ создаёт новые рецепты.')
      .addText((t) => t.setValue(this.plugin.settings.templatePath)
        .onChange(async (v) => { this.plugin.settings.templatePath = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName('Путь к образцу (эталон формата)')
      .setDesc('Готовый рецепт, чей стиль ИИ повторяет. По умолчанию — Блинчики.')
      .addText((t) => t.setValue(this.plugin.settings.examplePath)
        .onChange(async (v) => { this.plugin.settings.examplePath = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName('Папка рецептов')
      .setDesc('Куда сохранять новые рецепты кнопкой «Создать заметку».')
      .addText((t) => t.setValue(this.plugin.settings.recipesFolder)
        .onChange(async (v) => { this.plugin.settings.recipesFolder = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName('Категории (по одной на строку)')
      .setDesc('Заготовки для фильтров и выбора свойств рецепта.')
      .addTextArea((t) => { t.setValue(this.plugin.settings.categoriesList)
        .onChange(async (v) => { this.plugin.settings.categoriesList = v; await this.plugin.saveSettings(); });
        t.inputEl.rows = 5; t.inputEl.style.width = '100%'; });

    new Setting(containerEl).setName('Теги (по одному на строку)')
      .setDesc('Заготовки тегов для фильтров и выбора свойств рецепта.')
      .addTextArea((t) => { t.setValue(this.plugin.settings.tagsList)
        .onChange(async (v) => { this.plugin.settings.tagsList = v; await this.plugin.saveSettings(); });
        t.inputEl.rows = 4; t.inputEl.style.width = '100%'; });

    new Setting(containerEl).setName('Открывать книгу рецептов при запуске')
      .setDesc('Показывать галерею сразу при открытии Obsidian (удобно на телефоне).')
      .addToggle((t) => t.setValue(this.plugin.settings.openBookOnStart)
        .onChange(async (v) => { this.plugin.settings.openBookOnStart = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName('System prompt')
      .setDesc('Общие правила поведения ИИ.')
      .addTextArea((t) => { t.setValue(this.plugin.settings.systemPrompt)
        .onChange(async (v) => { this.plugin.settings.systemPrompt = v; await this.plugin.saveSettings(); });
        t.inputEl.rows = 5; t.inputEl.style.width = '100%'; });
  }
}
