# harness (CLI, Windows) — hand a CHR's connection env to an external tool.
# PowerShell can't eval the shell-quoted `env` output, so use --json and set
# $env:* explicitly. This is the natural Windows showcase for env-passing.
. "$PSScriptRoot/../common.ps1"

$name = Get-ExampleName 'harness'
Register-Cleanup $name

try {
	# secureLogin (the default) → a managed user with a real password.
	Invoke-Qc start $name --channel stable --mem 256

	Write-Host "-> connection env for ${name}:"
	$envMap = Invoke-Qc env $name --json | ConvertFrom-Json
	foreach ($prop in $envMap.PSObject.Properties) {
		Set-Item -Path "env:$($prop.Name)" -Value $prop.Value
	}

	Write-Host "-> running the external tool (tool/child.ts) with that env:"
	& bun run (Join-Path $PSScriptRoot 'tool/child.ts')
}
finally {
	Invoke-QcCleanup
}
