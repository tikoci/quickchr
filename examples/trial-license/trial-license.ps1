# trial-license (CLI, Windows) — apply a CHR trial license, read it back. MANUAL-ONLY.
# MikroTik rate-limits trial requests, so this is excluded from CI.
. "$PSScriptRoot/../common.ps1"

$name = Get-ExampleName 'trial-license'
Register-Cleanup $name

try {
	Invoke-Qc start $name --channel stable --no-secure-login --mem 256

	Write-Host "-> current license:"
	Invoke-Qc get $name license

	if ($env:MIKROTIK_WEB_ACCOUNT -and $env:MIKROTIK_WEB_PASSWORD) {
		Write-Host "-> applying p1 trial license..."
		Invoke-Qc set $name --license --level p1
		Invoke-Qc get $name license
	}
	else {
		Write-Host "-> set MIKROTIK_WEB_ACCOUNT / MIKROTIK_WEB_PASSWORD to apply a p1 trial (manual-only)."
	}
}
finally {
	Invoke-QcCleanup
}
