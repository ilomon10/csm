# Everything runs inside one invoked script block, so `irm | iex` leaks no parameters, functions or
# variables into the user's session. Its param block binds the flags; `@args` forwards them from the
# file (or from `& ([scriptblock]::Create((irm <url>))) -Uninstall -Purge`).
& {
  <#
  .SYNOPSIS
    csm installer for Windows (Windows PowerShell 5.1 and PowerShell 7).
  .DESCRIPTION
    Install / upgrade:  irm https://raw.githubusercontent.com/ilomon10/csm/main/scripts/install.ps1 | iex
    Uninstall:          & ([scriptblock]::Create((irm https://raw.githubusercontent.com/ilomon10/csm/main/scripts/install.ps1))) -Uninstall [-Purge]
    Env: CSM_VERSION, CSM_INSTALL_DIR, CSM_DOWNLOAD_BASE (replaces the release download URL; skips the API lookup).
  .PARAMETER Version
    Version to install (0.1.0-beta.1 or v0.1.0-beta.1). Default: latest release, prereleases included.
  .PARAMETER NoSetup
    Do not run "csm setup pwsh --yes" (PowerShell profile block).
  .PARAMETER Uninstall
    Run "csm uninstall --yes" and remove the binary and its PATH entry.
  .PARAMETER Purge
    With -Uninstall: also delete all csm data (CSM_HOME, every login).
  #>
  param(
    [string]$Version = $env:CSM_VERSION,
    [switch]$NoSetup,
    [switch]$Uninstall,
    [switch]$Purge
  )

  $repo = 'ilomon10/csm'
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  $tmp = $null

  function Say([string]$Message) { [Console]::Out.WriteLine($Message) }

  function Get-CsmInstallDir {
    if ($env:CSM_INSTALL_DIR) {
      # ';' would split the entry when it is written to the user PATH.
      if ($env:CSM_INSTALL_DIR.Contains(';')) { throw "CSM_INSTALL_DIR must not contain ';' (it is a PATH separator); got '$($env:CSM_INSTALL_DIR)'." }
      return [IO.Path]::GetFullPath($env:CSM_INSTALL_DIR)
    }
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is not set; set CSM_INSTALL_DIR to a writable directory.' }
    return (Join-Path $env:LOCALAPPDATA 'Programs\csm\bin')
  }

  function ConvertTo-PathKey([string]$Entry) {
    return $Entry.Trim().TrimEnd('\').ToLowerInvariant()
  }

  # The user PATH lives in HKCU\Environment. Read it unexpanded (so %USERPROFILE%-style entries survive)
  # and write it back as REG_EXPAND_SZ.
  function Get-UserPathRaw {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
    if (-not $key) { return '' }
    try {
      return [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    } finally {
      $key.Close()
    }
  }

  function Save-UserPathRaw([string]$Value) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    try {
      $key.SetValue('Path', $Value, [Microsoft.Win32.RegistryValueKind]::ExpandString)
    } finally {
      $key.Close()
    }
    # Deleting an unused variable makes .NET broadcast WM_SETTINGCHANGE, so new terminals see the change.
    try { [Environment]::SetEnvironmentVariable('CSM_INSTALLER_NOTIFY', $null, 'User') } catch { $null = $_ }
  }

  function ConvertTo-PathEntryKey([string]$Entry) {
    return (ConvertTo-PathKey ([Environment]::ExpandEnvironmentVariables($Entry)))
  }

  function Install-UserPathEntry([string]$Dir) {
    $key = ConvertTo-PathKey $Dir
    $entries = @((Get-UserPathRaw) -split ';' | Where-Object { $_ -ne '' })
    if (-not ($entries | Where-Object { (ConvertTo-PathEntryKey $_) -eq $key })) {
      Save-UserPathRaw ((@($entries) + $Dir) -join ';')
      Say "Added $Dir to your user PATH."
    }
    $session = @($env:Path -split ';' | Where-Object { $_ -ne '' })
    if (-not ($session | Where-Object { (ConvertTo-PathKey $_) -eq $key })) {
      $env:Path = "$env:Path;$Dir"
    }
  }

  function Uninstall-UserPathEntry([string]$Dir) {
    $key = ConvertTo-PathKey $Dir
    $entries = @((Get-UserPathRaw) -split ';' | Where-Object { $_ -ne '' })
    $kept = @($entries | Where-Object { (ConvertTo-PathEntryKey $_) -ne $key })
    if ($kept.Count -ne $entries.Count) {
      Save-UserPathRaw ($kept -join ';')
      Say "Removed $Dir from your user PATH."
    }
    $env:Path = (@($env:Path -split ';' | Where-Object { $_ -ne '' -and (ConvertTo-PathKey $_) -ne $key }) -join ';')
  }

  # Semver-ish with optional leading v. \z, not $, so a trailing newline cannot slip through.
  function Test-CsmVersion([string]$Value) {
    return ($Value -match '^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?\z')
  }

  # Only https:// and local absolute file:///C:/... bases are allowed (no http://, no UNC file://host/...).
  function Test-CsmBase([string]$Value) {
    if ($Value -match '^https://[^/]') { return $true }
    if ($Value -match '^file:///[^/]') { return -not ([Uri]$Value).IsUnc }
    return $false
  }

  # Download a release asset (file:// bases are copied; everything else is fetched over TLS 1.2).
  function Get-CsmAsset([string]$Base, [string]$Name, [string]$OutFile) {
    $url = "$Base/$Name"
    if (-not (Test-CsmBase $url)) { throw "refusing non-HTTPS URL: $url" }
    if ($url -like 'file://*') {
      $src = ([Uri]$url).LocalPath
      if (-not (Test-Path -LiteralPath $src)) { throw "download failed: $url does not exist" }
      Copy-Item -LiteralPath $src -Destination $OutFile -Force
      return
    }
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $OutFile
    } catch {
      throw "download failed: $url ($($_.Exception.Message))"
    }
  }

  function Get-LatestTag {
    $headers = @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'csm-installer' }
    if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $($env:GITHUB_TOKEN)" }
    try {
      $releases = Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/$repo/releases?per_page=10" -Headers $headers
    } catch {
      throw "could not query the GitHub releases API ($($_.Exception.Message)). Pass -Version X, or set GITHUB_TOKEN."
    }
    foreach ($r in @($releases)) {
      if (-not $r.draft) {
        $t = [string]$r.tag_name
        if (-not (Test-CsmVersion $t)) { throw "the releases API returned an invalid tag '$t'; pass -Version X." }
        return $t
      }
    }
    throw "no published release found for $repo. Pass -Version X to choose one."
  }

  function Get-WindowsArch {
    $arch = $null
    try { $arch = [string][Runtime.InteropServices.RuntimeInformation]::OSArchitecture } catch { $arch = $null }
    if (-not $arch) {
      $arch = $env:PROCESSOR_ARCHITEW6432
      if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
    }
    return $arch
  }

  # Remove a file; if it is locked (running exe), rename it to <name>.old instead.
  function Uninstall-CsmFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    try {
      Remove-Item -LiteralPath $Path -Force
    } catch {
      Move-Item -LiteralPath $Path -Destination "$Path.old" -Force
    }
  }

  try {
    # Windows PowerShell 5.1 defaults to TLS 1.0/1.1, which GitHub rejects.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    if ($Purge -and -not $Uninstall) { throw '-Purge only works together with -Uninstall.' }
    if (-not [Environment]::OSVersion.Platform.ToString().StartsWith('Win')) {
      throw 'install.ps1 is for Windows. On Linux/macOS use: curl -fsSL https://raw.githubusercontent.com/ilomon10/csm/main/scripts/install.sh | sh'
    }

    try {
      $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
      if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Warning 'Running as Administrator: csm is a per-user tool and installs into your user profile. Prefer a normal (non-elevated) PowerShell.'
      }
    } catch { $null = $_ }

    $installDir = Get-CsmInstallDir
    $dest = Join-Path $installDir 'csm.exe'
    $old = "$dest.old"

    if ($Uninstall) {
      if (Test-Path -LiteralPath $dest) {
        $uargs = @('uninstall', '--yes')
        if ($Purge) { $uargs += '--purge' }
        & $dest @uargs
        if ($LASTEXITCODE -ne 0) { throw "`"csm uninstall`" failed (exit $LASTEXITCODE); the binary was left in place at $dest" }
        Uninstall-CsmFile $dest
      } else {
        Write-Warning "csm binary not found at $dest; PowerShell profile blocks not removed."
      }
      Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
      if ((Test-Path -LiteralPath $installDir) -and -not (Get-ChildItem -LiteralPath $installDir -Force)) {
        Remove-Item -LiteralPath $installDir -Force -ErrorAction SilentlyContinue
      }
      Uninstall-UserPathEntry $installDir
      Say "csm removed from $dest"
      return
    }

    # --- install / upgrade ---
    $arch = Get-WindowsArch
    switch -Regex ($arch) {
      '^(X64|AMD64)$' { break }
      '^ARM64$' { Say 'Note: ARM64 Windows detected; installing the x64 build, which runs under emulation.'; break }
      default { throw "unsupported architecture '$arch': csm ships a Windows x64 build only. Use npm instead (see https://github.com/$repo#install)." }
    }

    $base = $env:CSM_DOWNLOAD_BASE
    if ($base -and -not (Test-CsmBase $base)) {
      throw "CSM_DOWNLOAD_BASE must start with https:// or file:///C:/... (no http://, no UNC); got '$base'."
    }
    if ($Version) {
      if (-not (Test-CsmVersion $Version)) { throw "invalid version '$Version' (expected e.g. 0.1.0 or v0.1.0-beta.1)." }
      $tag = if ($Version.StartsWith('v')) { $Version } else { "v$Version" }
    } elseif ($base) {
      throw 'CSM_DOWNLOAD_BASE is set, so the version cannot be looked up; pass -Version X or set CSM_VERSION.'
    } else {
      Say 'Looking up the latest release...'
      $tag = Get-LatestTag
    }
    if (-not $base) { $base = "https://github.com/$repo/releases/download/$tag" }
    $base = $base.TrimEnd('/')
    $ver = $tag.Substring(1)
    $asset = 'csm-windows-x64.exe'

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('csm-install-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null

    Say "Downloading $asset ($tag)..."
    Get-CsmAsset $base $asset (Join-Path $tmp $asset)
    Get-CsmAsset $base 'SHA256SUMS' (Join-Path $tmp 'SHA256SUMS')

    $want = $null
    foreach ($line in (Get-Content -LiteralPath (Join-Path $tmp 'SHA256SUMS'))) {
      if ($line -match '^([0-9A-Fa-f]{64})\s+\*?(.+?)\s*$' -and $Matches[2] -eq $asset) { $want = $Matches[1]; break }
    }
    if (-not $want) { throw "SHA256SUMS has no entry for $asset; refusing to install." }
    $got = (Get-FileHash -LiteralPath (Join-Path $tmp $asset) -Algorithm SHA256).Hash
    if ($want -ne $got) {
      throw "checksum mismatch for $asset (expected $($want.ToLower()), got $($got.ToLower())); the download is corrupt or tampered with. Nothing was installed."
    }
    Say 'Checksum OK.'

    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    # A previous upgrade may have left a renamed exe behind.
    Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
    $stage = Join-Path $installDir ".csm.tmp.$PID.exe"
    Copy-Item -LiteralPath (Join-Path $tmp $asset) -Destination $stage -Force
    $movedOld = $false
    try {
      if (Test-Path -LiteralPath $dest) {
        # A running csm.exe cannot be overwritten, but it can be renamed.
        Move-Item -LiteralPath $dest -Destination $old -Force
        $movedOld = $true
      }
      Move-Item -LiteralPath $stage -Destination $dest -Force
    } catch {
      if ($movedOld -and -not (Test-Path -LiteralPath $dest)) { Move-Item -LiteralPath $old -Destination $dest -Force -ErrorAction SilentlyContinue }
      Remove-Item -LiteralPath $stage -Force -ErrorAction SilentlyContinue
      throw "could not install to ${dest}: $($_.Exception.Message)"
    }
    Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue

    Install-UserPathEntry $installDir

    if (-not $NoSetup) {
      & $dest setup pwsh --yes
      if ($LASTEXITCODE -ne 0) {
        Write-Warning "`"csm setup`" failed (exit $LASTEXITCODE); run it yourself later: csm setup pwsh --yes"
      }
    }

    Say "csm $ver installed to $dest"
    Say 'Next: csm add <name>'
  } catch {
    [Console]::Error.WriteLine("error: $($_.Exception.Message)")
    # As a file the caller needs a non-zero exit code. Under iex / a script block `exit` would close the
    # user's shell, so stop with a terminating error instead.
    if ($PSCommandPath) { exit 1 }
    throw 'csm installer failed (see the error above)'
  } finally {
    if ($tmp -and (Test-Path -LiteralPath $tmp)) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
  }
} @args
