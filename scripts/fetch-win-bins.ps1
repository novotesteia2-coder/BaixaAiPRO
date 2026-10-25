$ErrorActionPreference = "Stop"
$Bin = Join-Path (Split-Path $PSScriptRoot -Parent) "bin"
New-Item -ItemType Directory -Force -Path $Bin | Out-Null
$Bin = (Resolve-Path $Bin).Path

Write-Host "==> Baixando deno"
Invoke-WebRequest -Uri "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip" -OutFile "$env:TEMP\deno.zip"
Expand-Archive "$env:TEMP\deno.zip" -DestinationPath $Bin -Force

Write-Host "==> Baixando yt-dlp"
Invoke-WebRequest -Uri "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" -OutFile (Join-Path $Bin "yt-dlp.exe")

Write-Host "==> Baixando ffmpeg"
Invoke-WebRequest -Uri "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" -OutFile "$env:TEMP\ff.zip"
$d = "$env:TEMP\ff"; if (Test-Path $d) { Remove-Item $d -Recurse -Force }
Expand-Archive "$env:TEMP\ff.zip" -DestinationPath $d -Force
Copy-Item (Get-ChildItem $d -Recurse -Filter ffmpeg.exe | Select-Object -First 1).FullName (Join-Path $Bin "ffmpeg.exe")
Copy-Item (Get-ChildItem $d -Recurse -Filter ffprobe.exe | Select-Object -First 1).FullName (Join-Path $Bin "ffprobe.exe")

Write-Host "==> OK"
Get-ChildItem $Bin | Select-Object Name, Length
