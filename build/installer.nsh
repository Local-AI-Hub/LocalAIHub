!macro customInit
  DetailPrint `Stopping any running "${PRODUCT_NAME}" processes before install.`
  !ifdef INSTALL_MODE_PER_ALL_USERS
    nsExec::Exec `taskkill /f /t /im "${APP_EXECUTABLE_FILENAME}"`
  !else
    nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c taskkill /f /t /im "${APP_EXECUTABLE_FILENAME}" /fi "USERNAME eq %USERNAME%"`
  !endif
  Sleep 1200
!macroend
!macro customInstall
  StrCpy $R0 "$INSTDIR\resources\icon.ico"
  ${if} ${FileExists} "$R0"
    !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
      Delete "$newStartMenuLink"
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$R0" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    !endif

    !ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT
      ${ifNot} ${isNoDesktopShortcut}
        Delete "$newDesktopLink"
        CreateShortCut "$newDesktopLink" "$appExe" "" "$R0" 0 "" "" "${APP_DESCRIPTION}"
        ClearErrors
        WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
      ${endIf}
    !endif

    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${endIf}
!macroend

!macro customUnInit
  StrCpy $R3 "0"
  StrCpy $R4 "0"

  ReadINIStr $R5 "$APPDATA\LocalAIHub\uninstall-cleanup.ini" "cleanup" "ConfigRoot"
  ${if} $R5 != ""
    StrCpy $R4 "1"
  ${endIf}
  ReadINIStr $R5 "$APPDATA\LocalAIHub\uninstall-cleanup.ini" "cleanup" "LocalRoot"
  ${if} $R5 != ""
    StrCpy $R4 "1"
  ${endIf}
  ReadINIStr $R5 "$APPDATA\LocalAIHub\uninstall-cleanup.ini" "cleanup" "ToolsRoot"
  ${if} $R5 != ""
    StrCpy $R4 "1"
  ${endIf}
  ReadINIStr $R5 "$APPDATA\LocalAIHub\uninstall-cleanup.ini" "cleanup" "ModelsRoot"
  ${if} $R5 != ""
    StrCpy $R4 "1"
  ${endIf}
  ReadINIStr $R5 "$APPDATA\LocalAIHub\uninstall-cleanup.ini" "cleanup" "DownloadsRoot"
  ${if} $R5 != ""
    StrCpy $R4 "1"
  ${endIf}
  ReadINIStr $R5 "$APPDATA\LocalAIHub\uninstall-cleanup.ini" "cleanup" "SnapshotsRoot"
  ${if} $R5 != ""
    StrCpy $R4 "1"
  ${endIf}
  ReadINIStr $R5 "$APPDATA\LocalAIHub\uninstall-cleanup.ini" "cleanup" "RuntimesRoot"
  ${if} $R5 != ""
    StrCpy $R4 "1"
  ${endIf}
  ReadINIStr $R5 "$APPDATA\LocalAIHub\uninstall-cleanup.ini" "cleanup" "LogsRoot"
  ${if} $R5 != ""
    StrCpy $R4 "1"
  ${endIf}

  ClearErrors
  ${GetParameters} $R1
  ${GetOptions} $R1 "--delete-app-data" $R2
  ${ifNot} ${Errors}
    StrCpy $R3 "1"
  ${endIf}

  ${if} $R4 == "1"
    ${if} $R3 != "1"
      ${ifNot} ${Silent}
        MessageBox MB_YESNO|MB_ICONQUESTION "Also delete Local AI Hub data stored outside this app folder? This includes managed tools, downloaded models, snapshots, logs, and settings in AppData." IDYES enableExternalCleanup IDNO cleanupPromptDone
        enableExternalCleanup:
          StrCpy $R3 "1"
      ${endIf}
    ${endIf}
  ${endIf}

  cleanupPromptDone:
!macroend

!macro customUnInstall
  ${if} $R3 == "1"
    ReadINIStr $R4 "$APPDATA\LocalAIHub\uninstall-cleanup.ini" "cleanup" "ToolsRoot"
    ${if} $R4 != ""
      RMDir /r "$R4"
    ${endIf}
    ReadINIStr $R4 "$APPDATA\LocalAIHub\uninstall-cleanup.ini" "cleanup" "ModelsRoot"
    ${if} $R4 != ""
      RMDir /r "$R4"
    ${endIf}
    ReadINIStr $R4 "$APPDATA\LocalAIHub\uninstall-cleanup.ini" "cleanup" "DownloadsRoot"
    ${if} $R4 != ""
      RMDir /r "$R4"
    ${endIf}
    ReadINIStr $R4 "$APPDATA\LocalAIHub\uninstall-cleanup.ini" "cleanup" "SnapshotsRoot"
    ${if} $R4 != ""
      RMDir /r "$R4"
    ${endIf}
    ReadINIStr $R4 "$APPDATA\LocalAIHub\uninstall-cleanup.ini" "cleanup" "RuntimesRoot"
    ${if} $R4 != ""
      RMDir /r "$R4"
    ${endIf}
    ReadINIStr $R4 "$APPDATA\LocalAIHub\uninstall-cleanup.ini" "cleanup" "LogsRoot"
    ${if} $R4 != ""
      RMDir /r "$R4"
    ${endIf}
    ReadINIStr $R4 "$APPDATA\LocalAIHub\uninstall-cleanup.ini" "cleanup" "LocalRoot"
    ${if} $R4 != ""
      RMDir /r "$R4"
    ${endIf}
    ReadINIStr $R4 "$APPDATA\LocalAIHub\uninstall-cleanup.ini" "cleanup" "ConfigRoot"
    ${if} $R4 != ""
      RMDir /r "$R4"
    ${endIf}
  ${endIf}
!macroend
