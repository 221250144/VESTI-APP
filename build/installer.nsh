!ifndef BUILD_UNINSTALLER
  LangString VestiFinishTitle 2052 "Vesti 安装完成"
  LangString VestiFinishTitle 1033 "Vesti installation complete"
  LangString VestiFinishText 2052 "Vesti 已成功安装。请按需选择下面的操作，然后单击完成。"
  LangString VestiFinishText 1033 "Vesti has been installed. Choose the actions below, then click Finish."
  LangString VestiDesktopText 2052 "创建桌面快捷方式"
  LangString VestiDesktopText 1033 "Create a desktop shortcut"
  LangString VestiRunText 2052 "运行 Vesti"
  LangString VestiRunText 1033 "Run Vesti"

  Function VestiCreateDesktopShortcut
    SetShellVarContext current
    CreateShortcut "$DESKTOP\Vesti.lnk" "$INSTDIR\vesti.exe"
  FunctionEnd

  Function VestiStartApp
    ExecShell "open" "$INSTDIR\vesti.exe"
  FunctionEnd

  !macro customWelcomePage
    !insertmacro MUI_PAGE_WELCOME
  !macroend

  !macro customFinishPage
    !define MUI_FINISHPAGE_TITLE "$(VestiFinishTitle)"
    !define MUI_FINISHPAGE_TEXT "$(VestiFinishText)"
    !define MUI_FINISHPAGE_SHOWREADME
    !define MUI_FINISHPAGE_SHOWREADME_TEXT "$(VestiDesktopText)"
    !define MUI_FINISHPAGE_SHOWREADME_FUNCTION VestiCreateDesktopShortcut
    !define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_TEXT "$(VestiRunText)"
    !define MUI_FINISHPAGE_RUN_FUNCTION VestiStartApp
    !insertmacro MUI_PAGE_FINISH
  !macroend
!endif

!macro customUnInstall
  SetShellVarContext current
  Delete "$DESKTOP\Vesti.lnk"
!macroend
