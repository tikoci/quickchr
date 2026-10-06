# CLI boot/configuration with the same assertions as the library example.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../common.ps1"
$env:QUICKCHR = $script:Quickchr
& bun run "$PSScriptRoot/cmr.ts" --cli @args
if ($LASTEXITCODE -ne 0) { throw "CMR example failed ($LASTEXITCODE)" }
