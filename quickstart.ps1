$ErrorActionPreference = 'Stop'

Set-Location -Path $PSScriptRoot

Write-Host '======================================'
Write-Host 'Phong hoc tieng Anh - Khoi dong nhanh (PowerShell)'
Write-Host '======================================'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '[ERROR] Node.js chua duoc cai dat hoac chua co trong PATH.' -ForegroundColor Red
  Write-Host 'Vui long cai Node.js LTS roi chay lai quickstart.ps1.'
  exit 1
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Host '[ERROR] npm khong co san trong PATH.' -ForegroundColor Red
  Write-Host 'Vui long cai dat lai Node.js LTS.'
  exit 1
}

if (-not (Test-Path -Path 'node_modules')) {
  Write-Host '[INFO] Dang cai dat dependencies lan dau...'
  npm install
  if ($LASTEXITCODE -ne 0) {
    Write-Host '[ERROR] Cai dat dependencies that bai.' -ForegroundColor Red
    exit 1
  }
}

Write-Host '[INFO] Dang chay ung dung (frontend + backend)...'
Write-Host '[INFO] Nhan Ctrl+C de dung.'

npm run dev

if ($LASTEXITCODE -ne 0) {
  Write-Host '[ERROR] Ung dung dung bat thuong.' -ForegroundColor Red
  exit $LASTEXITCODE
}
