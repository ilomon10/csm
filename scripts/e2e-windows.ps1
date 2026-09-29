# CI helper: installer end-to-end on Windows, run by ci.yml under both pwsh and Windows PowerShell 5.1.
# Expects build\bin\csm.exe and a repo-root working directory.
$ErrorActionPreference = 'Stop'
$version = node -p "require('./package.json').version"
$art = Join-Path $env:RUNNER_TEMP 'art'
New-Item -ItemType Directory -Force -Path $art | Out-Null
Copy-Item build\bin\csm.exe (Join-Path $art 'csm-windows-x64.exe')
$hash = (Get-FileHash (Join-Path $art 'csm-windows-x64.exe') -Algorithm SHA256).Hash.ToLower()
[IO.File]::WriteAllText((Join-Path $art 'SHA256SUMS'), "$hash  csm-windows-x64.exe`n")

$home2 = Join-Path $env:RUNNER_TEMP 'home'
New-Item -ItemType Directory -Force -Path $home2 | Out-Null
$env:HOME = $home2
$env:USERPROFILE = $home2
$env:CSM_HOME = Join-Path $home2 'csm-data'
$env:CSM_PWSH_PROFILE = Join-Path $home2 'profile.ps1'
$env:CSM_INSTALL_DIR = Join-Path $home2 'bin'
$env:CSM_DOWNLOAD_BASE = ([Uri]$art).AbsoluteUri

& .\scripts\install.ps1 -Version $version
if ($LASTEXITCODE -ne 0) { throw "install failed" }
& .\scripts\install.ps1 -Version $version
if ($LASTEXITCODE -ne 0) { throw "upgrade failed" }

$csm = Join-Path $env:CSM_INSTALL_DIR 'csm.exe'
if ((& $csm --version) -ne $version) { throw "unexpected csm --version" }
if (-not (Select-String -Path $env:CSM_PWSH_PROFILE -Pattern '>>> csm >>>' -Quiet)) { throw "profile block missing" }
if (@(Select-String -Path $env:CSM_PWSH_PROFILE -Pattern '>>> csm >>>').Count -ne 1) { throw "profile block duplicated" }

# doctor may exit 1 (claude is not installed on the runner); the JSON must still parse
$json = (& $csm doctor --json | Out-String)
$null = $json | ConvertFrom-Json

& $csm add x --no-login
if ($LASTEXITCODE -ne 0) { throw "csm add failed" }
& $csm rm x --yes
if ($LASTEXITCODE -ne 0) { throw "csm rm failed" }

& .\scripts\install.ps1 -Uninstall -Purge
if ($LASTEXITCODE -ne 0) { throw "uninstall failed" }
if (Test-Path $csm) { throw "binary still present" }
if (Test-Path $env:CSM_HOME) { throw "CSM_HOME still present" }
if ((Test-Path $env:CSM_PWSH_PROFILE) -and (Select-String -Path $env:CSM_PWSH_PROFILE -Pattern '>>> csm >>>' -Quiet)) { throw "profile block still present" }
