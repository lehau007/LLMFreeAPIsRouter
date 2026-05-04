# LLMFreeAPIsRouter Windows Setup Script

Write-Host "--- LLMFreeAPIsRouter Setup ---" -ForegroundColor Cyan

# 1. Check for Node.js
if (!(Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Error: Node.js is not installed. Please install it from https://nodejs.org/" -ForegroundColor Red
    exit
}

# 2. Copy .env if it doesn't exist
if (!(Test-Path .env)) {
    Write-Host "Creating .env from .env.example..." -ForegroundColor Yellow
    Copy-Item .env.example .env
    Write-Host "Done. Please edit .env and add your keys." -ForegroundColor Green
} else {
    Write-Host ".env already exists, skipping." -ForegroundColor Gray
}

# 3. Install dependencies
Write-Host "Installing dependencies (npm install)..." -ForegroundColor Yellow
npm install

# 4. Instructions
Write-Host "`n--- Setup Complete ---" -ForegroundColor Cyan
Write-Host "To run the project:" -ForegroundColor White
Write-Host "  npm run dev" -ForegroundColor Green
Write-Host "`nTo encrypt your API keys:" -ForegroundColor White
Write-Host "  npm run vault" -ForegroundColor Green
Write-Host "`nMake sure to set your MASTER_KEY in .env (min 32 chars) before encrypting keys." -ForegroundColor Yellow
