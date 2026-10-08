/* Relay panel - the words Relay adds to WhatsApp, in Chinese and Russian (page side).
   Relay's own screens (the Relay panel, captions, notices) follow the language Windows is set to; WhatsApp's own
   screens follow WhatsApp. The English text is the key, so a missing translation simply stays in English.
   Only text people read is translated here: the names Relay looks for in WhatsApp's buttons (aria-label) never are.
   window.__relayLang is set by the main process (the Windows language, even when WhatsApp itself is pinned to English). */
(() => {
  'use strict';
  if (window.__relayT) return;

  const lang = String(window.__relayLang || navigator.language || 'en').slice(0, 2).toLowerCase();

  const zh = {
    'Add-ons': '附加组件', 'Installed': '已安装', 'Download': '下载', 'Downloaded': '已下载', 'Live captions and recording transcripts': '实时字幕和录音文字稿', 'Better for Chinese, Russian, Hindi; needs a faster graphics card': '更适合中文、俄语、印地语；需要更快的显卡', 'No internet connection - try again when you are online': '没有网络连接——请联网后重试',
    'Transcript': '文字稿', 'Turn a call recording into a text transcript': '把通话录音转成文字稿', 'A transcript is already being made': '正在生成文字稿', 'That recording has no sound to transcribe': '该录音没有可转写的声音', 'No speech was found in that recording': '该录音中没有找到语音', 'Downloading the speech model': '正在下载语音模型',
    'Translated': '已翻译', 'Already in English': '已经是英文', 'Nothing to translate in that message': '这条消息没有可翻译的文字',
    'Live voice translation': '实时语音翻译', 'Press T in a call. Speaks the translation in a copy of the speaker voice': '通话中按 T。用说话人声音的复制品读出译文', 'I want to hear': '我想听到的语言', 'They should hear': '对方应听到的语言', 'Translate what they say': '翻译对方的话', 'Translate my voice': '翻译我的话', 'Forget my voice': '清除我的声音档案', 'Your voice profile was deleted': '已删除您的声音档案', 'Start a call first': '请先开始通话', 'Live translation is on - the other person hears a short notice before your first sentence': '实时翻译已开启——对方会在您第一句话之前听到一段简短提示', 'Live translation could not start': '无法启动实时翻译', 'Live translation could not listen to this call': '实时翻译无法监听此通话', 'Loading live translation...': '正在加载实时翻译…', 'Translation is not keeping up - your own voice is being sent': '翻译跟不上——现在发送的是您本人的声音', 'Your own voice is not translated: turn on "Voice clarity" in the Relay panel first': '您的声音未被翻译：请先在 Relay 面板中开启“语音清晰度”', 'Live translation is on (': '实时翻译已开启（', 'Translate this call out loud (T)': '将此通话实时翻译成语音 (T)', 'Starting live translation...': '正在启动实时翻译…',
    'Appearance': '外观', 'Chats': '聊天', 'Notifications': '通知', 'Calls': '通话', 'Language': '语言', 'Network': '网络',
    'Quick replies': '快捷回复', 'Quick settings': '快捷设置', 'Recordings': '录音录像', 'About': '关于', 'Diagnostics': '诊断', 'Save a report of recent problems to Documents': '将近期问题报告保存到“文档”', 'Saved Relay-diagnostics.txt to Documents': '已将 Relay-diagnostics.txt 保存到“文档”', 'Close': '关闭',
    'Dark': '深色', 'Light': '浅色', 'Theme': '主题',
    'WhatsApp reloads for a moment when you change it.': '更改后 WhatsApp 会短暂重新加载。',
    'Switching to the dark theme...': '正在切换到深色主题…', 'Switching to the light theme...': '正在切换到浅色主题…',
    'Finish the call first - changing the theme reloads WhatsApp for a moment': '请先结束通话——更改主题会让 WhatsApp 短暂重新加载',
    'Translate chats': '翻译聊天', 'Any language to casual English': '任何语言译成口语化英语',
    'Free models, your own key. Create one at openrouter.ai/keys, then add it here.': '免费模型，使用您自己的密钥。请在 openrouter.ai/keys 创建后在此添加。',
    'Keeps the tone and feeling of the original. Needs your own API key.': '保留原文的语气和感觉。需要您自己的 API 密钥。',
    'Free, no key. A literal translation, with a light casual touch.': '免费，无需密钥。偏直译，略带口语感。',
    'Add key': '添加密钥', 'Replace key': '更换密钥', 'Remove': '移除', 'Get a free key': '获取免费密钥',
    'In a chat, use the translate button at the top to turn it on for just that chat.': '在聊天中，点击顶部的翻译按钮即可只为该聊天开启翻译。',
    'Do not disturb': '勿扰模式', 'Silences pop-ups, sound and flashing': '关闭弹窗、声音和闪烁',
    'Noise suppression': '降噪', 'Removes background noise from your mic': '消除麦克风中的背景噪音',
    'Enhance camera': '增强摄像头', 'Brighter, cleaner video': '画面更亮更干净',
    'Sharper video': '更清晰的视频', 'Clearer picture from the people you call': '让对方的画面更清晰',
    'Voice clarity': '语音清晰度', 'Levelling and EQ for your voice': '为您的声音均衡音量与音色',
    'Record calls automatically': '自动录制通话', 'Saved to your Videos folder': '保存到“视频”文件夹',
    'Captions language': '字幕语言', 'Live captions: tap CC in a call': '实时字幕：通话中点击 CC',
    'In a call: M mute · V camera · S share screen · F full screen · R record · C captions': '通话中：M 静音 · V 摄像头 · S 共享屏幕 · F 全屏 · R 录制 · C 字幕',
    'My language': '我的语言', 'English': 'English', 'WhatsApp language': 'WhatsApp 语言',
    'Call extras (captions, record, shortcuts, back) need WhatsApp in English.': '通话附加功能（字幕、录制、快捷键、返回）需要 WhatsApp 使用英文界面。',
    'Proxy address': '代理地址', 'Proxy saved': '代理已保存', 'Save proxy': '保存代理', 'Using the Windows settings': '使用 Windows 设置',
    'Use Windows settings': '使用 Windows 设置', 'Relay follows your Windows proxy / VPN settings.': 'Relay 跟随 Windows 的代理 / VPN 设置。',
    'Only needed if WhatsApp is blocked where you are and your VPN does not set the Windows proxy itself. Leave empty to follow Windows.': '仅当您所在地区无法访问 WhatsApp，且 VPN 不会自动设置 Windows 代理时才需要填写。留空则跟随 Windows。',
    'Add a quick reply': '添加快捷回复', 'New quick reply': '新的快捷回复', 'Add quick reply': '添加快捷回复', 'Remove quick reply': '删除快捷回复',
    'No quick replies yet.': '还没有快捷回复。', 'Tap one to drop it into the message box.': '点击即可放入输入框。', 'Add one': '添加', 'Manage': '管理',
    'Open a chat first': '请先打开一个聊天', 'Open a chat with messages first': '请先打开有消息的聊天',
    'Something went wrong': '出了点问题', 'Timed out': '超时',
    'Translate this chat': '翻译此聊天', 'Translate this chat to English': '将此聊天翻译成英语',
    'Translating this chat (click to stop)': '正在翻译此聊天（点击停止）', 'Translating this chat to casual English': '正在将此聊天翻译成口语化英语',
    'Translation off for this chat': '已关闭此聊天的翻译',
    'Caption settings': '字幕设置', 'Caption language': '字幕语言', 'Translate captions to': '字幕翻译为', 'Translate to': '翻译为',
    'Spoken language': '对方说的语言', 'Automatic': '自动识别', 'Text size': '字号', 'Position': '位置', 'Bottom': '底部', 'Top': '顶部', 'Show original words': '显示原文', 'Show the original words too': '同时显示原文',
    'Accuracy': '准确度', 'Fast': '快速', 'Accurate': '精确',
    'Drag the captions anywhere on the call; double-click to put them back.': '可将字幕拖到通话画面的任意位置；双击还原。',
    'Speech is turned into text on this PC.': '语音在这台电脑上转换为文字。',
    'Listening…': '正在聆听…', 'Starting captions…': '正在启动字幕…', 'Loading speech model…': '正在加载语音模型…', 'Catching up...': '正在追赶…',
    'Turn on captions': '开启字幕', 'Turn off captions': '关闭字幕',
    'Your voice can only be translated into English, Hindi, Chinese, Russian or Spanish': '你的声音目前只能翻译成英语、印地语、中文、俄语或西班牙语',
    'Live voice translation (about 3 GB)': '实时语音翻译（约 3 GB）', 'Translator and voices, for translating calls out loud': '翻译器和语音，用于朗读通话译文',
    'Captions could not start': '无法启动字幕','Captions could not listen to this call': '字幕无法监听此通话',
    'Captions are falling behind. Try Accuracy: Fast in the caption settings (tap the caption label).': '字幕跟不上说话速度。请在字幕设置中将“准确度”改为“快速”（点击字幕标签）。'
  };

  const ru = {
    'Add-ons': 'Дополнения', 'Installed': 'Установлено', 'Download': 'Скачать', 'Downloaded': 'Загружено', 'Live captions and recording transcripts': 'Живые субтитры и расшифровки записей', 'Better for Chinese, Russian, Hindi; needs a faster graphics card': 'Лучше для китайского, русского, хинди; нужна более мощная видеокарта', 'No internet connection - try again when you are online': 'Нет подключения к интернету — повторите, когда будете в сети',
    'Transcript': 'Расшифровка', 'Turn a call recording into a text transcript': 'Превратить запись звонка в текстовую расшифровку', 'A transcript is already being made': 'Расшифровка уже создаётся', 'That recording has no sound to transcribe': 'В этой записи нет звука для расшифровки', 'No speech was found in that recording': 'В записи не найдена речь', 'Downloading the speech model': 'Загрузка модели речи',
    'Translated': 'Переведено', 'Already in English': 'Уже на английском', 'Nothing to translate in that message': 'В этом сообщении нечего переводить',
    'Live voice translation': 'Живой голосовой перевод', 'Press T in a call. Speaks the translation in a copy of the speaker voice': 'Нажмите T во время звонка. Перевод звучит копией голоса говорящего', 'I want to hear': 'Хочу слышать на языке', 'They should hear': 'Собеседник должен слышать на языке', 'Translate what they say': 'Переводить слова собеседника', 'Translate my voice': 'Переводить мой голос', 'Forget my voice': 'Удалить мой голосовой профиль', 'Your voice profile was deleted': 'Ваш голосовой профиль удалён', 'Start a call first': 'Сначала начните звонок', 'Live translation is on - the other person hears a short notice before your first sentence': 'Перевод включён — перед вашей первой фразой собеседник услышит короткое уведомление', 'Live translation could not start': 'Не удалось запустить перевод', 'Live translation could not listen to this call': 'Перевод не смог прослушать этот звонок', 'Loading live translation...': 'Загрузка перевода…', 'Translation is not keeping up - your own voice is being sent': 'Перевод не успевает — передаётся ваш собственный голос', 'Your own voice is not translated: turn on "Voice clarity" in the Relay panel first': 'Ваш голос не переводится: сначала включите «Чёткость голоса» в панели Relay', 'Live translation is on (': 'Перевод включён (', 'Translate this call out loud (T)': 'Переводить этот звонок голосом (T)', 'Starting live translation...': 'Запуск перевода…',
    'Appearance': 'Оформление', 'Chats': 'Чаты', 'Notifications': 'Уведомления', 'Calls': 'Звонки', 'Language': 'Язык', 'Network': 'Сеть',
    'Quick replies': 'Быстрые ответы', 'Quick settings': 'Быстрые настройки', 'Recordings': 'Записи', 'About': 'О программе', 'Diagnostics': 'Диагностика', 'Save a report of recent problems to Documents': 'Сохранить отчёт о недавних проблемах в «Документы»', 'Saved Relay-diagnostics.txt to Documents': 'Relay-diagnostics.txt сохранён в «Документы»', 'Close': 'Закрыть',
    'Dark': 'Тёмная', 'Light': 'Светлая', 'Theme': 'Тема',
    'WhatsApp reloads for a moment when you change it.': 'При смене темы WhatsApp ненадолго перезагрузится.',
    'Switching to the dark theme...': 'Включается тёмная тема…', 'Switching to the light theme...': 'Включается светлая тема…',
    'Finish the call first - changing the theme reloads WhatsApp for a moment': 'Сначала завершите звонок: при смене темы WhatsApp ненадолго перезагрузится',
    'Translate chats': 'Перевод чатов', 'Any language to casual English': 'С любого языка на разговорный английский',
    'Free models, your own key. Create one at openrouter.ai/keys, then add it here.': 'Бесплатные модели, ваш собственный ключ. Создайте его на openrouter.ai/keys и добавьте здесь.',
    'Keeps the tone and feeling of the original. Needs your own API key.': 'Сохраняет тон и настроение оригинала. Нужен ваш собственный ключ API.',
    'Free, no key. A literal translation, with a light casual touch.': 'Бесплатно, без ключа. Близкий к тексту перевод с лёгкой разговорной окраской.',
    'Add key': 'Добавить ключ', 'Replace key': 'Заменить ключ', 'Remove': 'Удалить', 'Get a free key': 'Получить бесплатный ключ',
    'In a chat, use the translate button at the top to turn it on for just that chat.': 'В чате нажмите кнопку перевода вверху, чтобы включить перевод только для этого чата.',
    'Do not disturb': 'Не беспокоить', 'Silences pop-ups, sound and flashing': 'Отключает всплывающие окна, звук и мигание',
    'Noise suppression': 'Шумоподавление', 'Removes background noise from your mic': 'Убирает фоновый шум с микрофона',
    'Enhance camera': 'Улучшение камеры', 'Brighter, cleaner video': 'Ярче и чище изображение',
    'Sharper video': 'Чёткое видео', 'Clearer picture from the people you call': 'Более чёткая картинка собеседника',
    'Voice clarity': 'Чёткость голоса', 'Levelling and EQ for your voice': 'Выравнивание громкости и тембра голоса',
    'Record calls automatically': 'Записывать звонки автоматически', 'Saved to your Videos folder': 'Сохраняется в папку «Видео»',
    'Captions language': 'Язык субтитров', 'Live captions: tap CC in a call': 'Живые субтитры: нажмите CC во время звонка',
    'In a call: M mute · V camera · S share screen · F full screen · R record · C captions': 'Во время звонка: M микрофон · V камера · S экран · F во весь экран · R запись · C субтитры',
    'My language': 'Мой язык', 'English': 'English', 'WhatsApp language': 'Язык WhatsApp',
    'Call extras (captions, record, shortcuts, back) need WhatsApp in English.': 'Дополнительные функции звонков (субтитры, запись, горячие клавиши, «назад») работают, когда WhatsApp на английском.',
    'Proxy address': 'Адрес прокси', 'Proxy saved': 'Прокси сохранён', 'Save proxy': 'Сохранить прокси', 'Using the Windows settings': 'Используются настройки Windows',
    'Use Windows settings': 'Настройки Windows', 'Relay follows your Windows proxy / VPN settings.': 'Relay использует прокси / VPN-настройки Windows.',
    'Only needed if WhatsApp is blocked where you are and your VPN does not set the Windows proxy itself. Leave empty to follow Windows.': 'Нужно только если WhatsApp у вас заблокирован, а VPN сам не меняет прокси Windows. Оставьте пустым, чтобы использовать настройки Windows.',
    'Add a quick reply': 'Добавьте быстрый ответ', 'New quick reply': 'Новый быстрый ответ', 'Add quick reply': 'Добавить быстрый ответ', 'Remove quick reply': 'Удалить быстрый ответ',
    'No quick replies yet.': 'Быстрых ответов пока нет.', 'Tap one to drop it into the message box.': 'Нажмите, чтобы вставить в поле сообщения.', 'Add one': 'Добавить', 'Manage': 'Изменить',
    'Open a chat first': 'Сначала откройте чат', 'Open a chat with messages first': 'Сначала откройте чат с сообщениями',
    'Something went wrong': 'Что-то пошло не так', 'Timed out': 'Время ожидания истекло',
    'Translate this chat': 'Перевести этот чат', 'Translate this chat to English': 'Перевести этот чат на английский',
    'Translating this chat (click to stop)': 'Чат переводится (нажмите, чтобы остановить)', 'Translating this chat to casual English': 'Чат переводится на разговорный английский',
    'Translation off for this chat': 'Перевод для этого чата выключен',
    'Caption settings': 'Настройки субтитров', 'Caption language': 'Язык субтитров', 'Translate captions to': 'Переводить субтитры на', 'Translate to': 'Перевод на',
    'Spoken language': 'Язык собеседника', 'Automatic': 'Автоопределение', 'Text size': 'Размер текста', 'Position': 'Положение', 'Bottom': 'Снизу', 'Top': 'Сверху', 'Show original words': 'Показывать оригинал', 'Show the original words too': 'Показывать и оригинал',
    'Accuracy': 'Точность', 'Fast': 'Быстро', 'Accurate': 'Точно',
    'Drag the captions anywhere on the call; double-click to put them back.': 'Перетащите субтитры в любое место на экране звонка; двойной щелчок возвращает их на место.',
    'Speech is turned into text on this PC.': 'Речь преобразуется в текст на этом компьютере.',
    'Listening…': 'Слушаю…', 'Starting captions…': 'Запуск субтитров…', 'Loading speech model…': 'Загрузка модели речи…', 'Catching up...': 'Не успеваю…',
    'Turn on captions': 'Включить субтитры', 'Turn off captions': 'Выключить субтитры',
    'Your voice can only be translated into English, Hindi, Chinese, Russian or Spanish': 'Ваш голос пока можно перевести только на английский, хинди, китайский, русский или испанский',
    'Live voice translation (about 3 GB)': 'Живой голосовой перевод (около 3 ГБ)', 'Translator and voices, for translating calls out loud': 'Переводчик и голоса для озвучивания перевода звонков',
    'Captions could not start': 'Не удалось запустить субтитры','Captions could not listen to this call': 'Субтитры не смогли прослушать этот звонок',
    'Captions are falling behind. Try Accuracy: Fast in the caption settings (tap the caption label).': 'Субтитры не успевают за речью. В настройках субтитров выберите «Точность: Быстро» (нажмите на метку субтитров).'
  };

  // Strings with a changing part (a name, a percentage, a reason).
  const rules = {
    zh: [
      [/^Downloading speech model (\d+)%$/, (m) => '正在下载语音模型 ' + m[1] + '%'],
      [/^Captions: (.*)$/, (m) => '字幕：' + m[1]],
      [/^Translation: (.*)$/, (m) => '翻译：' + m[1]],
      [/^Translated from (.*)$/, (m) => '译自 ' + m[1]],
      [/^Relay connects through (.*)$/, (m) => 'Relay 通过 ' + m[1] + ' 连接'],
      [/^Your (.*) key is saved on this PC$/, (m) => '您的 ' + m[1] + ' 密钥已保存在这台电脑上'],
      [/^Add your (.*) API key in the Relay panel first$/, (m) => '请先在 Relay 面板中添加您的 ' + m[1] + ' API 密钥'],
      [/^Translation paused for 5 minutes: (.*)$/, (m) => '翻译已暂停 5 分钟：' + m[1]],
      [/^Accurate downloads (\d+) MB once and needs a fast graphics card\.$/, (m) => '“精确”模式需一次性下载 ' + m[1] + ' MB，并需要性能较好的显卡。']
    ],
    ru: [
      [/^Downloading speech model (\d+)%$/, (m) => 'Загрузка модели речи ' + m[1] + '%'],
      [/^Captions: (.*)$/, (m) => 'Субтитры: ' + m[1]],
      [/^Translation: (.*)$/, (m) => 'Перевод: ' + m[1]],
      [/^Translated from (.*)$/, (m) => 'Переведено с языка: ' + m[1]],
      [/^Relay connects through (.*)$/, (m) => 'Relay подключается через ' + m[1]],
      [/^Your (.*) key is saved on this PC$/, (m) => 'Ваш ключ ' + m[1] + ' сохранён на этом компьютере'],
      [/^Add your (.*) API key in the Relay panel first$/, (m) => 'Сначала добавьте ключ API ' + m[1] + ' в панели Relay'],
      [/^Translation paused for 5 minutes: (.*)$/, (m) => 'Перевод приостановлен на 5 минут: ' + m[1]],
      [/^Accurate downloads (\d+) MB once and needs a fast graphics card\.$/, (m) => 'Режим «Точно» один раз загружает ' + m[1] + ' МБ и требует мощную видеокарту.']
    ]
  };
  const table = { zh, ru }[lang];

  const T = (s) => {
    if (!table || typeof s !== 'string' || !s) return s;
    if (Object.prototype.hasOwnProperty.call(table, s)) return table[s];
    for (const [re, fn] of rules[lang]) { const m = re.exec(s); if (m) return fn(m); }
    return s;
  };

  Object.defineProperty(window, '__relayT', { value: T, enumerable: false });
  Object.defineProperty(window, '__relayDict', { value: { zh, ru, rules }, enumerable: false });
})();
