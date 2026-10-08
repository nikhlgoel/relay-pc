Relay setup kit  (version {{VERSION}})
======================================

English
-------
What it does
  1. Removes WhatsApp Desktop (Microsoft Store and the older installer version),
     our first "WhatsApp" wrapper (1.0.0) and the Aura / WaDesk builds -
     including their shortcuts, startup entries and saved data on this PC.
  2. Installs Relay from RelayInstaller{{VERSION}}.exe (silently, for your account only),
     registers it with Windows (Start menu, search, Default apps) and, if a "models" folder
     is next to this script, adds the offline speech models for live captions.
  Your chats are not affected: they live on your phone. You scan a QR code once in Relay.

How to use
  1. Right-click the zip -> Properties -> tick "Unblock" (if shown) -> OK.
  2. Right-click the zip -> Extract All.   (Do not run it from inside the zip.)
  3. Double-click  Install-Relay.cmd   and answer Y when asked.
     If Windows shows a blue "protected your PC" box: More info -> Run anyway.
  4. When it says "All done", open Relay from the Start menu (search "Relay").

Where WhatsApp is blocked (mainland China, Russia, ...)
  - WhatsApp itself needs a VPN there. Turn the VPN on BEFORE opening Relay.
  - Relay follows the Windows proxy / VPN settings. If your VPN app only opens a local proxy port
    (for example 127.0.0.1:7890) and does not set the Windows proxy, open Relay's panel
    (the "R" button in the left bar) -> Network -> type that address -> Save.
    Calls work best with a VPN in "TUN / virtual adapter" mode (all traffic), not a browser-only proxy.
  - Live captions need a speech model. If huggingface.co is blocked, Relay uses hf-mirror.com, or you can
    put the files from RelaySpeechModels.zip into the "models" folder of this kit before running the installer.
  - Captions translated to English work without Google when the speech model is present (done on your PC).
    Translating to other languages needs Google Translate, which may be blocked: then the caption stays in the spoken language.
  - On a PC set to Chinese or Russian, Relay asks once whether to show WhatsApp in English. Its call extras
    (captions, recording, shortcuts, back button) need the English button names. You can change this in the Relay panel.

Good to know
  - It shows what it found BEFORE removing anything, and asks first.
  - To only see what it would do:   Install-Relay.cmd -DryRun
  - To keep old saved data:         Install-Relay.cmd -KeepData
  - It never touches Relay's own data, so running it again is safe.
  - Log of everything it did:       %TEMP%\Relay-Setup-<date-time>.log
  - If it says the Store version of WhatsApp could not be removed, uninstall it in
    Settings > Apps > Installed apps, then run Install-Relay.cmd again.
  - Antivirus: the installer is not code-signed, so SmartScreen or an antivirus (for example 360) may warn.
    Check the file against the SHA-256 on the download page / in latest.yml, then allow it.

简体中文
--------
作用
  1. 卸载微软商店版和旧安装版 WhatsApp 桌面应用、我们最早的 1.0.0 “WhatsApp”封装版、以及 Aura / WaDesk，
     并清除它们的快捷方式、开机启动项和保存的数据。
  2. 静默安装 Relay（仅为当前用户），并注册到 Windows（开始菜单、搜索、默认应用）；
     如果脚本旁有 models 文件夹，会一并安装离线语音模型（用于实时字幕）。
  聊天记录不受影响（保存在手机上），在 Relay 中扫码登录一次即可。

使用方法
  1. 右键点击 zip → 属性 → 如有“解除锁定”请勾选 → 确定。
  2. 右键点击 zip → 全部提取。（不要在压缩包内直接运行）
  3. 双击 Install-Relay.cmd，出现提示时输入 Y。
     若 Windows 弹出蓝色“已保护你的电脑”窗口：点“更多信息” → “仍要运行”。
  4. 显示 All done 后，在开始菜单搜索 “Relay” 打开。

在无法访问 WhatsApp 的地区（中国大陆等）
  - WhatsApp 本身需要 VPN。请先打开 VPN，再打开 Relay。
  - Relay 会跟随 Windows 的代理 / VPN 设置。如果您的 VPN 软件只提供本地代理端口（例如 127.0.0.1:7890）
    而没有设置 Windows 代理：打开 Relay 面板（左侧栏的 “R” 按钮）→ 网络 → 填写该地址 → 保存。
    通话建议使用“TUN / 虚拟网卡”模式（全局流量），不要只用浏览器代理。
  - 实时字幕需要语音模型：无法访问 huggingface.co 时，Relay 会自动改用 hf-mirror.com；
    也可以在运行安装程序前，把 RelaySpeechModels.zip 里的文件放进本工具包的 models 文件夹。
  - 已有语音模型时，字幕翻译成英文无需 Google（在本机完成）；翻译成其他语言需要 Google 翻译，被屏蔽时字幕会保持原语言。
  - 在中文系统上，Relay 会询问一次是否让 WhatsApp 显示英文界面（字幕、录音、快捷键、返回键等附加功能需要英文按钮名称）。
    之后可在 Relay 面板中修改。
  - 安装程序未做代码签名，SmartScreen 或杀毒软件（如 360）可能提示风险。请核对 SHA-256 后选择允许。

Русский
-------
Что делает
  1. Удаляет WhatsApp Desktop (из Microsoft Store и старый установщик), нашу первую оболочку «WhatsApp» 1.0.0
     и сборки Aura / WaDesk вместе с ярлыками, автозапуском и сохранёнными данными.
  2. Тихо устанавливает Relay (для вашей учётной записи), регистрирует его в Windows (меню «Пуск», поиск,
     «Приложения по умолчанию») и, если рядом есть папка models, добавляет офлайн-модели речи для живых субтитров.
  Переписка не затрагивается (она хранится на телефоне); QR-код нужно отсканировать один раз.

Как пользоваться
  1. ПКМ по zip → Свойства → поставьте «Разблокировать» (если есть) → OK.
  2. ПКМ по zip → Извлечь всё. (Не запускайте из архива.)
  3. Дважды щёлкните Install-Relay.cmd и ответьте Y.
     Если Windows показывает синее окно «Windows защитила ваш компьютер»: Подробнее → Выполнить в любом случае.
  4. После «All done» найдите «Relay» в меню «Пуск».

Если WhatsApp заблокирован (Россия и др.)
  - Для самого WhatsApp нужен VPN. Включите VPN ДО запуска Relay.
  - Relay использует прокси / VPN-настройки Windows. Если ваш VPN даёт только локальный порт прокси
    (например, 127.0.0.1:7890) и не меняет прокси Windows: откройте панель Relay (кнопка «R» слева) →
    Сеть (Network) → введите адрес → Сохранить. Для звонков лучше режим VPN «TUN / виртуальный адаптер» (весь трафик).
  - Для субтитров нужна модель речи. Если huggingface.co недоступен, Relay берёт её с hf-mirror.com;
    можно также положить файлы из RelaySpeechModels.zip в папку models этого набора до запуска установки.
  - Перевод субтитров на английский при наличии модели работает без Google (на вашем ПК); перевод на другие
    языки требует Google Переводчик — если он недоступен, субтитры остаются на языке оригинала.
  - В системе с русским языком Relay один раз спросит, показывать ли WhatsApp на английском (дополнительные
    функции звонков ищут английские названия кнопок). Выбор можно изменить в панели Relay.
  - Установщик не подписан цифровой подписью: SmartScreen или антивирус могут предупредить. Сверьте SHA-256 и разрешите запуск.
