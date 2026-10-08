; Extra Windows registration for Relay, run by electron-builder's NSIS installer (package.json > build.nsis.include).
; electron-builder already writes the Start-menu and desktop shortcuts (with the app's identity and icon) and the
; "Apps & features" uninstall entry. This adds what makes the app easy to find and launch:
;   - App Paths   : Win+R > relay, the Start-menu search and "open with" find Relay.exe wherever it was installed
;   - Applications: a friendly name and the real icon wherever Windows lists the program
;   - Capabilities: Relay shows up under Settings > Apps > Default apps, with its icon and the whatsapp: link type
; Everything is written for the install mode the user picked (this user only, or all users) and removed on uninstall.

!macro relayRegister
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}" "Path" "$INSTDIR"

  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "${PRODUCT_NAME}"
  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  WriteRegStr SHCTX "Software\Classes\RelayURL" "" "${PRODUCT_NAME} (WhatsApp link)"
  WriteRegStr SHCTX "Software\Classes\RelayURL" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\RelayURL\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Classes\RelayURL\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  WriteRegStr SHCTX "Software\Relay\Capabilities" "ApplicationName" "${PRODUCT_NAME}"
  WriteRegStr SHCTX "Software\Relay\Capabilities" "ApplicationDescription" "A fast desktop app for WhatsApp"
  WriteRegStr SHCTX "Software\Relay\Capabilities" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Relay\Capabilities\URLAssociations" "whatsapp" "RelayURL"
  WriteRegStr SHCTX "Software\RegisteredApplications" "Relay" "Software\Relay\Capabilities"

  ; Tell Explorer and the Start menu that programs changed, so Relay appears in search without a sign-out.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro relayUnregister
  DeleteRegKey SHCTX "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}"
  DeleteRegKey SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  DeleteRegKey SHCTX "Software\Classes\RelayURL"
  DeleteRegKey SHCTX "Software\Relay"
  DeleteRegValue SHCTX "Software\RegisteredApplications" "Relay"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customInstall
  !insertmacro relayRegister
!macroend

!macro customUnInstall
  !insertmacro relayUnregister
!macroend
