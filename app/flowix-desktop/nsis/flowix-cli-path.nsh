!define FLOWIX_STATE_DIR "$LOCALAPPDATA\FlowixData"
!define FLOWIX_CLI_BIN_DIR "$LOCALAPPDATA\Flowix\bin"
!define FLOWIX_CLI_SHIM "${FLOWIX_CLI_BIN_DIR}\flowix.cmd"
!define FLOWIX_LEGACY_CLI_SHIM "${FLOWIX_CLI_BIN_DIR}\flowix-cli.cmd"
!define FLOWIX_HELPER_SOURCE "${__FILEDIR__}\flowix-installer-helper.exe"
Var FlowixSavedOutDir

!macro FLOWIX_BROADCAST_ENVIRONMENT_CHANGE
  System::Call 'user32::SendMessageTimeout(i 0xffff, i 0x001A, i 0, t "Environment", i 0, i 5000, *i .r0)'
!macroend

!macro FLOWIX_LOG message
  CreateDirectory "${FLOWIX_STATE_DIR}"
  FileOpen $R9 "${FLOWIX_STATE_DIR}\app-update.log" a
  ${If} $R9 != ""
    FileSeek $R9 0 END
    FileWrite $R9 "install=$INSTDIR ${message}$\r$\n"
    FileClose $R9
  ${EndIf}
!macroend

!macro FLOWIX_RECORD_SILENT_UPDATE_RESULT result message
  ${If} ${Silent}
  ${AndIf} ${FileExists} "${FLOWIX_STATE_DIR}\app-update-target.txt"
    CreateDirectory "${FLOWIX_STATE_DIR}"
    FileOpen $0 "${FLOWIX_STATE_DIR}\app-update-result.txt" w
    ${If} $0 != ""
      FileWrite $0 "${result}|${message}$\r$\n"
      FileClose $0
    ${EndIf}
  ${EndIf}
!macroend

; The standard template calls this for install and uninstall. Replace its
; name-only kill with a path-scoped preflight. Test when upgrading Tauri.
!ifmacrondef CheckIfAppIsRunning
  !error "Tauri CheckIfAppIsRunning macro is missing; review installer integration before upgrading Tauri."
!endif
!macroundef CheckIfAppIsRunning
!macro CheckIfAppIsRunning executableName productName
  StrCpy $FlowixSavedOutDir $OUTDIR
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=flowix-installer-helper.exe "${FLOWIX_HELPER_SOURCE}"
flowix_preflight_retry:
  nsExec::ExecToLog '"$PLUGINSDIR\flowix-installer-helper.exe" --mode prepare --target "$INSTDIR" --main-executable "${executableName}" --source nsis --version "${VERSION}" --timeout-ms 30000 --interval-ms 200 --log "${FLOWIX_STATE_DIR}\app-update.log" --error-file "$PLUGINSDIR\flowix-error.txt"'
  Pop $1
  ${If} $1 != 0
    StrCpy $2 "Flowix could not prepare installation. See ${FLOWIX_STATE_DIR}\app-update.log."
    ClearErrors
    FileOpen $0 "$PLUGINSDIR\flowix-error.txt" r
    ${IfNot} ${Errors}
      FileReadUTF16LE $0 $2
      FileClose $0
    ${EndIf}
    !insertmacro FLOWIX_LOG "preflight-failed exit=$1 reason=$2"
    ${IfNot} ${Silent}
      MessageBox MB_ICONEXCLAMATION|MB_RETRYCANCEL|MB_DEFBUTTON2 "$2" IDRETRY flowix_preflight_retry
    ${EndIf}
    SetOutPath "$FlowixSavedOutDir"
    SetErrorLevel 1
    Abort
  ${EndIf}
  SetOutPath "$FlowixSavedOutDir"
  ClearErrors
!macroend

; Tauri owns .onInstSuccess. Extraction failures also reach this callback.
Function .onInstFailed
  !insertmacro FLOWIX_LOG "installation-failed"
  !insertmacro FLOWIX_RECORD_SILENT_UPDATE_RESULT "failed" "Installation failed. Check the installer log and run setup again."
  SetErrorLevel 1
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  ; An older app updater wrote these markers beside its executable. Adopt only
  ; its update status, never its program directory or user data.
  ${If} ${Silent}
  ${AndIfNot} ${FileExists} "${FLOWIX_STATE_DIR}\app-update-target.txt"
  ${AndIf} ${FileExists} "$LOCALAPPDATA\Flowix\app-update-target.txt"
    CreateDirectory "${FLOWIX_STATE_DIR}"
    CopyFiles /SILENT "$LOCALAPPDATA\Flowix\app-update-target.txt" "${FLOWIX_STATE_DIR}\app-update-target.txt"
  ${EndIf}
!macroend

!macro FLOWIX_ADD_CLI_TO_USER_PATH
  ReadRegStr $0 HKCU "Environment" "Path"
  StrCpy $1 0
  StrCpy $2 1
  StrCpy $4 "$0;"
  ${Do}
    ClearErrors
    ${WordFind} "$4" ";" "E+$2" $3
    ${If} ${Errors}
      ${ExitDo}
    ${EndIf}
    ${If} $3 == "${FLOWIX_CLI_BIN_DIR}"
      StrCpy $1 1
      ${ExitDo}
    ${EndIf}
    IntOp $2 $2 + 1
  ${Loop}

  ${If} $1 == 0
    ${If} $0 == ""
      StrCpy $0 "${FLOWIX_CLI_BIN_DIR}"
    ${Else}
      StrCpy $0 "$0;${FLOWIX_CLI_BIN_DIR}"
    ${EndIf}
    WriteRegExpandStr HKCU "Environment" "Path" "$0"
    !insertmacro FLOWIX_BROADCAST_ENVIRONMENT_CHANGE
  ${EndIf}
!macroend

; Older Flowix builds registered these extensions as "Flowix Document".
; Restore the prior class only when the extension still points at Flowix, so an
; update does not overwrite a file association the user changed afterward.
!macro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION extension
  ReadRegStr $R0 SHCTX "Software\Classes\.${extension}" ""
  ${If} $R0 == "Flowix Document"
    ClearErrors
    ReadRegStr $R1 SHCTX "Software\Classes\.${extension}" "Flowix Document_backup"
    ${If} ${Errors}
      DeleteRegValue SHCTX "Software\Classes\.${extension}" ""
    ${ElseIf} $R1 == ""
      DeleteRegValue SHCTX "Software\Classes\.${extension}" ""
    ${Else}
      WriteRegStr SHCTX "Software\Classes\.${extension}" "" "$R1"
    ${EndIf}
  ${EndIf}
  DeleteRegValue SHCTX "Software\Classes\.${extension}" "Flowix Document_backup"
!macroend

!macro FLOWIX_CLEANUP_LEGACY_DOCUMENT_ASSOCIATIONS
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "txt"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "csv"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "json"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "yaml"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "yml"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "toml"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "xml"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "html"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "htm"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "css"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "js"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "jsx"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "ts"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "tsx"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "py"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "rs"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "go"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "java"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "c"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "cpp"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "h"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "sh"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "pdf"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "doc"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "docx"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "xls"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "xlsx"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "ppt"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "pptx"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "odt"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "ods"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "png"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "jpg"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "jpeg"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "gif"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "webp"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "svg"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "bmp"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "ico"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "tif"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "tiff"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "heic"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "mp4"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "webm"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "mov"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "avi"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "mkv"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "mp3"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "wav"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "ogg"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "flac"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "zip"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "rar"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "7z"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "tar"
  !insertmacro FLOWIX_REMOVE_LEGACY_DOCUMENT_ASSOCIATION "gz"
  DeleteRegKey SHCTX "Software\Classes\Flowix Document"
  !insertmacro UPDATEFILEASSOC
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro FLOWIX_CLEANUP_LEGACY_DOCUMENT_ASSOCIATIONS
  ; Visible/manual installs clear stale updater status without emitting a toast.
  IfSilent flowix_status_clear_done 0
  Delete "${FLOWIX_STATE_DIR}\app-update-result.txt"
  Delete "${FLOWIX_STATE_DIR}\app-update-target.txt"
flowix_status_clear_done:
  CreateDirectory "${FLOWIX_CLI_BIN_DIR}"
  Delete "${FLOWIX_LEGACY_CLI_SHIM}"
  FileOpen $0 "${FLOWIX_CLI_SHIM}" w
  ${If} $0 != ""
    FileWrite $0 "@echo off$\r$\n"
    FileWrite $0 "$\"$INSTDIR\flowix-cli.exe$\" %*$\r$\n"
    FileClose $0
  ${EndIf}
  !insertmacro FLOWIX_ADD_CLI_TO_USER_PATH
  !insertmacro FLOWIX_LOG "installation-complete"
  !insertmacro FLOWIX_RECORD_SILENT_UPDATE_RESULT "success" ""
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "${FLOWIX_CLI_SHIM}"
  Delete "${FLOWIX_LEGACY_CLI_SHIM}"
  RMDir "${FLOWIX_CLI_BIN_DIR}"
  ; Runtime data and old recovery folders belong to the user.
!macroend
