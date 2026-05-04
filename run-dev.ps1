# Run LLMFreeAPIsRouter in development mode
$scriptDir = Split-Path $MyInvocation.MyCommand.Path
Set-Location $scriptDir

Write-Host "Starting LLMFreeAPIsRouter in development mode..." -ForegroundColor Cyan

# Use node to call nodemon directly to avoid issues with '&' in paths
& node "node_modules/nodemon/bin/nodemon.js" src/index.ts

Read-Host "Press Enter to exit"
