param([string]$Domain = '')
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Install and start Docker Desktop with Linux containers first.' }
docker info *> $null
if ($LASTEXITCODE -ne 0) { throw 'Docker is not running. Start Docker Desktop first.' }
docker run --rm -e "SITE_ADDRESS=$Domain" --mount "type=bind,source=$PSScriptRoot\docker,target=/setup" node:22-bookworm-slim node /setup/setup.mjs
if ($LASTEXITCODE -ne 0) { throw 'Could not generate Docker configuration.' }
docker compose --env-file docker/.env up -d --build --wait --wait-timeout 300
if ($LASTEXITCODE -ne 0) { throw 'Startup failed. Check docker compose --env-file docker/.env logs.' }
Get-Content docker/credentials.txt
if ($Domain) { Write-Host "Fleet: https://$Domain   Simulator: https://$Domain/simulator/" }
else { Write-Host 'Fleet: http://localhost   Simulator: http://localhost/simulator/' }
