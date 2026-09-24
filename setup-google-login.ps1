param(
  [string]$ProfileImportPath = ""
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Created .env from .env.example"
}

npm install
if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

if (-not $ProfileImportPath) { $ProfileImportPath = $env:LOREMOTION_PROFILE_IMPORT_PATH }
if (-not $ProfileImportPath) {
  $ProfileImportPath = node --input-type=module -e "import 'dotenv/config'; process.stdout.write(process.env.LOREMOTION_PROFILE_IMPORT_PATH || '')"
}

if ($ProfileImportPath) {
  npm run import-profile -- $ProfileImportPath
  if ($LASTEXITCODE -ne 0) { throw "LoreMotion profile import failed" }
  npm run verify-login
  if ($LASTEXITCODE -ne 0) { throw "Imported LoreMotion session verification failed" }
  Write-Host "LoreMotion MCP imported-profile setup is complete."
  Write-Host "Start with: npm start"
  exit 0
}

if (-not [Environment]::UserInteractive) {
  throw "Interactive Google login is unavailable. Use: .\\setup-google-login.ps1 -ProfileImportPath <profile-or-archive>"
}

npm run install-browser
if ($LASTEXITCODE -ne 0) { throw "Playwright browser installation failed" }

npm run login
if ($LASTEXITCODE -ne 0) { throw "LoreMotion Google login was not verified" }

npm run verify-login
if ($LASTEXITCODE -ne 0) { throw "Saved LoreMotion session verification failed" }

Write-Host "LoreMotion MCP Google-login setup is complete."
Write-Host "Start with: npm start"
