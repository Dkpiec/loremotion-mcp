$ErrorActionPreference = "Stop"

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Created .env from .env.example"
}

npm install
if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

npm run install-browser
if ($LASTEXITCODE -ne 0) { throw "Playwright browser installation failed" }

npm run login
if ($LASTEXITCODE -ne 0) { throw "LoreMotion Google login was not verified" }

npm run verify-login
if ($LASTEXITCODE -ne 0) { throw "Saved LoreMotion session verification failed" }

Write-Host "LoreMotion MCP Google-login setup is complete."
Write-Host "Start with: npm start"
