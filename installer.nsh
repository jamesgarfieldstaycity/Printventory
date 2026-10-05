!macro preInit
    SetRegView 64
    WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "$PROGRAMFILES64\Printventory"
    WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$PROGRAMFILES64\Printventory"
    SetRegView 32
    WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "$PROGRAMFILES\Printventory"
    WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$PROGRAMFILES\Printventory"
!macroend

!macro customInstall
    SetOutPath "$INSTDIR"
    CreateDirectory "$LOCALAPPDATA\Printventory"
    CreateDirectory "$LOCALAPPDATA\Printventory\data"

    # Preserve existing database during updates
    ${If} ${FileExists} "$LOCALAPPDATA\Printventory\data\printventory.db"
        CreateDirectory "$LOCALAPPDATA\Printventory\data\backup"
        CopyFiles "$LOCALAPPDATA\Printventory\data\printventory.db" "$LOCALAPPDATA\Printventory\data\backup\printventory.db"
    ${EndIf}

    SetShellVarContext current
    # CreateShortCut "$DESKTOP\Printventory.lnk" "$INSTDIR\Printventory.exe"
    CreateDirectory "$SMPROGRAMS\Printventory"
    CreateShortCut "$SMPROGRAMS\Printventory\Printventory.lnk" "$INSTDIR\Printventory.exe"

    # Second Start Menu shortcut for server mode: same install, same exe, one
    # extra argument. This is the whole "switch mode by editing a shortcut"
    # story -- a user who wants server mode instead of desktop mode can copy
    # either shortcut and add/remove --server, rather than needing a second
    # install.
    CreateShortCut "$SMPROGRAMS\Printventory\Printventory (Server Mode).lnk" "$INSTDIR\Printventory.exe" "--server"

    # Autostart: a shortcut in the current user's Startup folder runs at
    # logon. This is NOT a Windows Service -- it starts after a user signs
    # in, not at boot, and it can't be started/stopped via services.msc or
    # `sc`. It is, however, the fastest way to get "starts with the
    # computer" working today without the larger core-extraction effort a
    # real service needs (see the project's install plan doc). Defaults to
    # desktop mode; edit this shortcut's target to add --server if you want
    # server mode to be what starts automatically instead.
    CreateShortCut "$SMSTARTUP\Printventory.lnk" "$INSTDIR\Printventory.exe"
!macroend

!macro customUnInstall
    SetShellVarContext current
    Delete "$DESKTOP\Printventory.lnk"
    Delete "$SMSTARTUP\Printventory.lnk"
    RMDir /r "$SMPROGRAMS\Printventory"

    # Don't remove user data on uninstall
    # RMDir /r "$LOCALAPPDATA\Printventory"

    # Instead, only remove the application files
    RMDir /r "$INSTDIR"
!macroend
