$ErrorActionPreference = "Stop"

$repo = "inds-space/plans"
$asset = "plan-windows-x64.exe"
$installDir = Join-Path $env:LOCALAPPDATA "Programs\plan"
$destination = Join-Path $installDir "plan.exe"
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest"
$download = $release.assets | Where-Object { $_.name -eq $asset } | Select-Object -First 1
if (-not $download) { throw "Release asset $asset was not found." }

New-Item -ItemType Directory -Path $installDir -Force | Out-Null
Invoke-WebRequest -Uri $download.browser_download_url -OutFile $destination

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ";") -notcontains $installDir) {
  [Environment]::SetEnvironmentVariable("Path", (($userPath.TrimEnd(";"), $installDir) -join ";"), "User")
}

Write-Output "Installed plan $($release.tag_name) to $destination"
Write-Output "Open a new terminal, then run: plan --help"

