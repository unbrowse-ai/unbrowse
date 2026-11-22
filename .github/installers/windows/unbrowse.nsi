; The Windows installer: the four programs from the release's windows-x64 zip (package-programs.sh), installed for the
; signed-in user alone (no administrator prompt) under %LOCALAPPDATA%\Programs\Unbrowse, with a Start menu entry for the
; window, an entry in Settings > Apps that uninstalls it, and the window started when the installer finishes. The
; window starts the node beside itself, so the owner's first screen is the window's own setup, as on a Mac.
;
; Built on Linux with makensis (package-windows-installer.sh):
;   makensis -DVERSION=<version> -DNUMERIC=<X.Y.Z.0> -DPROGRAMS=<folder> -DOUTFILE=<setup.exe> unbrowse.nsi
; The owner's data in %USERPROFILE%\.unbrowse is never touched: uninstalling removes the programs alone.

Unicode true
SetCompressor /SOLID lzma
RequestExecutionLevel user
ManifestDPIAware true

!include "MUI2.nsh"

Name "Unbrowse"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\Unbrowse"
InstallDirRegKey HKCU "Software\Unbrowse" "InstallDir"
BrandingText "Unbrowse ${VERSION}"

VIProductVersion "${NUMERIC}"
VIAddVersionKey "ProductName" "Unbrowse"
VIAddVersionKey "CompanyName" "Unbrowse"
VIAddVersionKey "FileDescription" "Unbrowse installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Unbrowse"

!define MUI_ICON "unbrowse.ico"
!define MUI_UNICON "unbrowse.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\unbrowse-window.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Open Unbrowse"

!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Unbrowse"

; A running copy holds its program files open, so an upgrade or an uninstall stops it first. The node keeps everything
; it needs in %USERPROFILE%\.unbrowse and starts again with the window.
!macro StopUnbrowse
  nsExec::Exec 'taskkill /F /T /IM unbrowse-window.exe'
  Pop $0
  nsExec::Exec 'taskkill /F /T /IM unbrowse-node.exe'
  Pop $0
  nsExec::Exec 'taskkill /F /T /IM agent-browser.exe'
  Pop $0
  Sleep 500
!macroend

Section "Unbrowse" SecMain
  SectionIn RO
  !insertmacro StopUnbrowse
  SetOutPath "$INSTDIR"
  File "${PROGRAMS}\unbrowse-node.exe"
  File "${PROGRAMS}\unb.exe"
  File "${PROGRAMS}\agent-browser.exe"
  File "${PROGRAMS}\unbrowse-window.exe"
  File "${PROGRAMS}\README.md"
  File "unbrowse.ico"
  WriteUninstaller "$INSTDIR\Uninstall Unbrowse.exe"

  CreateShortcut "$SMPROGRAMS\Unbrowse.lnk" "$INSTDIR\unbrowse-window.exe" "" "$INSTDIR\unbrowse.ico"

  WriteRegStr HKCU "Software\Unbrowse" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "Unbrowse"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Unbrowse"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "URLInfoAbout" "https://unbrowse.ai"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\unbrowse.ico"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall Unbrowse.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall Unbrowse.exe" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  !insertmacro StopUnbrowse
  Delete "$SMPROGRAMS\Unbrowse.lnk"
  Delete "$INSTDIR\unbrowse-node.exe"
  Delete "$INSTDIR\unb.exe"
  Delete "$INSTDIR\agent-browser.exe"
  Delete "$INSTDIR\unbrowse-window.exe"
  Delete "$INSTDIR\README.md"
  Delete "$INSTDIR\unbrowse.ico"
  Delete "$INSTDIR\Uninstall Unbrowse.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegKey HKCU "Software\Unbrowse"
SectionEnd
