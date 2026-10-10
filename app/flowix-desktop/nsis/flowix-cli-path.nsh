!define FLOWIX_CLI_BIN_DIR "$LOCALAPPDATA\Flowix\bin"
!define FLOWIX_CLI_SHIM "${FLOWIX_CLI_BIN_DIR}\flowix.cmd"
!define FLOWIX_LEGACY_CLI_SHIM "${FLOWIX_CLI_BIN_DIR}\flowix-cli.cmd"

!macro FLOWIX_BROADCAST_ENVIRONMENT_CHANGE
  System::Call 'user32::SendMessageTimeout(i 0xffff, i 0x001A, i 0, t "Environment", i 0, i 5000, *i .r0)'
!macroend

!macro FLOWIX_RECORD_SILENT_UPDATE_RESULT result message
  ; Only updater-launched /S installations persist a result for the relaunch.
  IfSilent 0 +7
  CreateDirectory "$LOCALAPPDATA\Flowix"
  FileOpen $0 "$LOCALAPPDATA\Flowix\app-update-result.txt" w
  FileWrite $0 "${result}|${message}$\r$\n"
  FileClose $0
  FileOpen $1 "$LOCALAPPDATA\Flowix\app-update.log" a
  FileWrite $1 "${result}|${message}$\r$\n"
  FileClose $1
!macroend

!macro FLOWIX_LOG message
  CreateDirectory "$LOCALAPPDATA\Flowix"
  FileOpen $R9 "$LOCALAPPDATA\Flowix\app-update.log" a
  ${If} $R9 != ""
    FileWrite $R9 "version=${VERSION} install=$INSTDIR ${message}$\r$\n"
    FileClose $R9
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

!macro FLOWIX_STOP_BUNDLED_CLI
  ; This helper is built and Authenticode-signed by the Windows release job.
  ; It closes only verified instances at $INSTDIR\flowix-cli.exe. It does not
  ; inspect command lines or terminate MCP hosts and supervisors.
  SetOutPath "$PLUGINSDIR"
  File "${__FILEDIR__}\flowix-installer-helper.exe"

flowix_stop_cli_retry:
  nsExec::ExecToLog '"$PLUGINSDIR\flowix-installer-helper.exe" --target "$INSTDIR\flowix-cli.exe" --source nsis --version "${VERSION}" --timeout-ms 10000 --interval-ms 200 --log "$LOCALAPPDATA\Flowix\app-update.log"'
  Pop $1
  StrCpy $2 "Flowix could not inspect running processes. Check the installer log."
  ${If} $1 == "error"
    StrCpy $2 "Flowix could not start its native installer helper. Check the installer log."
  ${ElseIf} $1 == 20
    StrCpy $2 "Flowix CLI is still running or is being restarted. Pause WorkBuddy or the app holding Flowix MCP, then retry."
  ${ElseIf} $1 == 21
    StrCpy $2 "Flowix could not close its CLI because permission was denied. Exit the app holding Flowix MCP, then retry."
  ${ElseIf} $1 == 22
    StrCpy $2 "The Flowix CLI file is still in use. Close the related app, then retry."
  ${ElseIf} $1 == 23
    StrCpy $2 "Flowix could not access the CLI file. Check the install directory permissions and installer log."
  ${ElseIf} $1 != 0
    StrCpy $2 "Flowix could not inspect or close the target CLI. Check the installer log."
  ${EndIf}

  ${If} $1 != 0
    IfSilent flowix_stop_cli_silent_failure 0
    MessageBox MB_ICONEXCLAMATION|MB_RETRYCANCEL|MB_DEFBUTTON2 "$2$\r$\n$\r$\nPause the Flowix MCP connection before retrying." IDRETRY flowix_stop_cli_retry IDABORT flowix_stop_cli_cancel
    Goto flowix_stop_cli_cancel
flowix_stop_cli_silent_failure:
    !insertmacro FLOWIX_RECORD_SILENT_UPDATE_RESULT "failed" "$2"
    SetErrorLevel 1
    Abort
flowix_stop_cli_cancel:
    SetErrorLevel 1
    Abort
  ${EndIf}
!macroend

!macro FLOWIX_BEGIN_INSTALL_TRANSACTION
  StrCpy $FlowixTxnActive 0
  StrCpy $FlowixHasPrevious 0
  StrCpy $FlowixBackupDir "$INSTDIR.flowix-rollback"
  IfFileExists "$FlowixBackupDir\*.*" flowix_rollback_exists 0
  IfFileExists "$FlowixBackupDir" flowix_rollback_exists 0
  IfFileExists "$INSTDIR\*.*" 0 flowix_no_previous_install
  ClearErrors
  Rename "$INSTDIR" "$FlowixBackupDir"
  IfErrors flowix_rollback_begin_failed
  StrCpy $FlowixTxnActive 1
  StrCpy $FlowixHasPrevious 1
  CreateDirectory "$INSTDIR"
  IfErrors flowix_rollback_begin_failed
  Goto flowix_transaction_started

flowix_rollback_exists:
  !insertmacro FLOWIX_LOG "transaction-aborted recovery-folder-exists path=$FlowixBackupDir"
  !insertmacro FLOWIX_RECORD_SILENT_UPDATE_RESULT "failed" "A previous Flowix recovery folder must be moved aside before retrying."
  IfSilent flowix_rollback_exists_done 0
  MessageBox MB_ICONSTOP "A previous Flowix installation recovery folder already exists:$\r$\n$FlowixBackupDir$\r$\nMove it aside before retrying this installation."
flowix_rollback_exists_done:
  SetErrorLevel 1
  Abort
flowix_rollback_begin_failed:
  !insertmacro FLOWIX_LOG "transaction-prepare-failed path=$FlowixBackupDir"
  !insertmacro FLOWIX_RECORD_SILENT_UPDATE_RESULT "failed" "Flowix could not prepare a recoverable installation."
  IfSilent flowix_rollback_begin_failed_done 0
  MessageBox MB_ICONSTOP "Flowix could not prepare a recoverable installation. Check the installer log and try again."
flowix_rollback_begin_failed_done:
  SetErrorLevel 1
  Abort
flowix_no_previous_install:
  ; Mark the transaction active so a failed first install removes its partial
  ; directory through the same recovery path.
  StrCpy $FlowixTxnActive 1
flowix_transaction_started:
  !insertmacro FLOWIX_LOG "transaction-start rollback=$FlowixBackupDir"
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro FLOWIX_STOP_BUNDLED_CLI
  !insertmacro FLOWIX_BEGIN_INSTALL_TRANSACTION
!macroend

!macro FLOWIX_PRE_REGISTRY_COMMIT
  ; Preserve legacy/runtime files outside the new bundle. Abort on failure so
  ; .onInstFailed can restore the previous installation directory.
  ${If} $FlowixHasPrevious == 1
    nsExec::ExecToLog '"$PLUGINSDIR\flowix-installer-helper.exe" --mode merge-missing --source-path "$FlowixBackupDir" --target "$INSTDIR" --log "$LOCALAPPDATA\Flowix\app-update.log"'
    Pop $1
    ${If} $1 != 0
      !insertmacro FLOWIX_LOG "commit-merge-failed exit=$1"
      !insertmacro FLOWIX_RECORD_SILENT_UPDATE_RESULT "failed" "Installation commit failed while preserving existing files."
      SetErrorLevel 1
      Abort
    ${EndIf}
    !insertmacro FLOWIX_LOG "commit-merge-complete"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Visible/manual installs clear stale updater status without emitting a toast.
  IfSilent flowix_status_clear_done 0
  Delete "$LOCALAPPDATA\Flowix\app-update-result.txt"
  Delete "$LOCALAPPDATA\Flowix\app-update-target.txt"
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
!macroend

!macro FLOWIX_TRANSACTION_SUCCESS
  ${If} $FlowixHasPrevious == 1
    RMDir /r "$FlowixBackupDir"
  ${EndIf}
  StrCpy $FlowixTxnActive 0
  !insertmacro FLOWIX_LOG "installation-success"
  ; Only the in-app updater creates this marker.
  IfFileExists "$LOCALAPPDATA\Flowix\app-update-target.txt" 0 flowix_transaction_success_done
  !insertmacro FLOWIX_RECORD_SILENT_UPDATE_RESULT "success" ""
flowix_transaction_success_done:
!macroend

!macro FLOWIX_TRANSACTION_FAILURE
  ; The install section changed $OUTDIR to $INSTDIR; leave it before deleting
  ; the partial tree and renaming the rollback directory back into place.
  SetOutPath "$PLUGINSDIR"
  ${If} $FlowixTxnActive == 1
    nsExec::ExecToLog '"$PLUGINSDIR\flowix-installer-helper.exe" --mode restore --source-path "$FlowixBackupDir" --target "$INSTDIR" --log "$LOCALAPPDATA\Flowix\app-update.log"'
    Pop $1
    ${If} $1 == 0
      StrCpy $FlowixTxnActive 0
      !insertmacro FLOWIX_LOG "installation-failed rollback=complete"
      !insertmacro FLOWIX_RECORD_SILENT_UPDATE_RESULT "failed" "Installation failed; the previous Flowix version was restored."
    ${Else}
      !insertmacro FLOWIX_LOG "installation-failed rollback=failed exit=$1 backup=$FlowixBackupDir"
      !insertmacro FLOWIX_RECORD_SILENT_UPDATE_RESULT "failed" "Installation and automatic recovery failed. Keep the recovery folder and reinstall Flowix."
      IfSilent flowix_skip_recovery_popup 0
      MessageBox MB_ICONSTOP "Flowix installation failed and automatic recovery also failed. Keep this recovery folder and reinstall Flowix:$\r$\n$FlowixBackupDir"
flowix_skip_recovery_popup:
    ${EndIf}
  ${Else}
    !insertmacro FLOWIX_LOG "installation-failed rollback=not-needed"
  ${EndIf}

  ; Tauri's quiet updater exits the old app before launching NSIS. If the old
  ; installation is intact (either no replacement began or rollback worked),
  ; relaunch it as the current user so it can report the saved failure result.
  ${If} $FlowixTxnActive == 0
    IfSilent 0 flowix_failure_relaunch_done
    IfFileExists "$LOCALAPPDATA\Flowix\app-update-target.txt" 0 flowix_failure_relaunch_done
    ${GetOptions} $CMDLINE "/R" $R0
    ${IfNot} ${Errors}
      ${GetOptions} $CMDLINE "/ARGS" $R0
      nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" "$R0"
    ${EndIf}
flowix_failure_relaunch_done:
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Only remove files created by the Flowix CLI shim. Do not modify the
  ; user's HKCU\Environment\Path during product uninstall.
  Delete "${FLOWIX_CLI_SHIM}"
  Delete "${FLOWIX_LEGACY_CLI_SHIM}"
  RMDir "${FLOWIX_CLI_BIN_DIR}"
!macroend
