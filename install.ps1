# unbrowse installer for Windows — https://github.com/unbrowse-ai/unbrowse
# Usage: irm https://unbrowse.ai/install.ps1 | iex
$ErrorActionPreference = 'Stop'

# Faster Invoke-WebRequest in PS 5.1 (no progress bar) and TLS 1.2 for older Windows
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$Repo = 'unbrowse-ai/unbrowse'
$InstallDir = if ($env:UNBROWSE_INSTALL_DIR) { $env:UNBROWSE_INSTALL_DIR }
              elseif (Test-Path "$HOME\.local\bin") { "$HOME\.local\bin" }
              else { "$env:LOCALAPPDATA\unbrowse\bin" }

$Interactive = [Environment]::UserInteractive -and ($env:UNBROWSE_NON_INTERACTIVE -ne '1')

# --- Fetch latest release ---
Write-Host 'Fetching latest unbrowse release...'
try {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -UseBasicParsing
    $Version = $release.tag_name
} catch {
    Write-Error "Error: could not determine latest version. $_"
    exit 1
}
if (-not $Version) { Write-Error 'Error: could not determine latest version'; exit 1 }

Write-Host "Installing unbrowse $Version (win-x64)..."

# --- Download and extract ---
$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "unbrowse-install-$([guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null

try {
    # Release assets: prefer the versioned tar.gz that build-binaries.sh actually produces;
    # fall back to the bare win-x64 exe. Windows 10 1803+ ships tar.exe.
    $TarUrl = "https://github.com/$Repo/releases/download/$Version/unbrowse-$Version-win-x64.tar.gz"
    $ExeUrl = "https://github.com/$Repo/releases/download/$Version/unbrowse-win-x64.exe"
    $TarPath = Join-Path $TmpDir 'unbrowse.tar.gz'
    $ExePath = Join-Path $TmpDir 'unbrowse.exe'

    $downloaded = $false
    if (Get-Command tar -ErrorAction SilentlyContinue) {
        try {
            Invoke-WebRequest -Uri $TarUrl -OutFile $TarPath -UseBasicParsing
            & tar -xzf $TarPath -C $TmpDir
            if ($LASTEXITCODE -ne 0) { throw "tar exited with $LASTEXITCODE" }
            $downloaded = $true
        } catch {
            Write-Host "tar.gz path failed, falling back to bare .exe: $_"
        }
    }

    if (-not $downloaded) {
        try {
            Invoke-WebRequest -Uri $ExeUrl -OutFile $ExePath -UseBasicParsing
            $downloaded = $true
        } catch {
            Write-Error "Failed to download unbrowse from release assets."
            exit 1
        }
    }

    # Locate the binary (tar may extract to a subdir; bare .exe is already at $ExePath)
    $SrcExe = Get-ChildItem -Path $TmpDir -Filter 'unbrowse.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $SrcExe) { Write-Error 'Error: unbrowse.exe not found in download'; exit 1 }

    # Install
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Copy-Item -Path $SrcExe.FullName -Destination (Join-Path $InstallDir 'unbrowse.exe') -Force

    Write-Host ''
    Write-Host "Installed: unbrowse.exe"
    Write-Host "Location:  $InstallDir"
    Write-Host ''

    # --- Update PATH (user-level, persists across sessions) ---
    $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($UserPath -notlike "*$InstallDir*") {
        [Environment]::SetEnvironmentVariable('Path', "$InstallDir;$UserPath", 'User')
        $env:Path = "$InstallDir;$env:Path"
        Write-Host "Added $InstallDir to your user PATH."
        Write-Host ''
    }

    # --- Run setup ---
    $SetupOk = $false
    if ($env:UNBROWSE_SKIP_SETUP -eq '1') {
        Write-Host "Next: unbrowse setup"
    } else {
        $SetupArgs = @('setup')
        if (-not $Interactive) { $SetupArgs += '--non-interactive', '--skip-wallet-setup' }
        if ($env:UNBROWSE_TOS_ACCEPTED -eq '1') { $SetupArgs += '--accept-tos' }
        if ($env:UNBROWSE_AGENT_EMAIL) { $SetupArgs += '--agent-email', $env:UNBROWSE_AGENT_EMAIL }
        if ($env:UNBROWSE_SKIP_WALLET_SETUP -eq '1' -and $SetupArgs -notcontains '--skip-wallet-setup') {
            $SetupArgs += '--skip-wallet-setup'
        }

        if (-not $Interactive -and $env:UNBROWSE_TOS_ACCEPTED -ne '1') {
            Write-Host 'Skipping interactive setup: non-interactive install requires $env:UNBROWSE_TOS_ACCEPTED=1.'
            Write-Host "Next: `$env:UNBROWSE_TOS_ACCEPTED='1'; unbrowse $($SetupArgs -join ' ')"
        } else {
            Write-Host 'Running unbrowse setup...'
            $env:UNBROWSE_SETUP_METHOD = 'npm-global'
            $Unbrowse = Join-Path $InstallDir 'unbrowse.exe'
            try {
                & $Unbrowse @SetupArgs
                $SetupOk = $true
            } catch {
                Write-Host "Setup failed: $_"
            }
        }
    }

    # --- Skills registry ---
    if ($env:UNBROWSE_SKIP_SKILLS_REGISTRY -eq '1') { exit 0 }
    if ($SetupOk -and (Get-Command npx -ErrorAction SilentlyContinue)) {
        Write-Host 'Registering with skills.sh...'
        try { npx -y skills add unbrowse-ai/unbrowse --yes 2>$null | Out-Null }
        catch { Write-Host 'Skipping skills.sh registry (command failed).' }
    }
} finally {
    Remove-Item -Path $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
}
