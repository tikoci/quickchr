# dude (CLI, Windows) — install the dude package on first boot, enable it, read it back.
# PowerShell mirror of dude.sh.
. "$PSScriptRoot/../common.ps1"

$name = Get-ExampleName 'dude'
Register-Cleanup $name

try {
	Write-Host "-> starting $name with --add-package dude (downloads the .npk, reboots once)..."
	Invoke-Qc start $name --channel stable --no-secure-login --add-package dude --mem 256

	Write-Host "-> enable the Dude server"
	Invoke-Qc exec $name "/dude/set enabled=yes"

	Write-Host "-> read it back (expect enabled: yes):"
	Invoke-Qc exec $name "/dude/print"
}
finally {
	Invoke-QcCleanup
}
