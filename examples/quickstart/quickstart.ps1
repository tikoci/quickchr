# quickstart (CLI, Windows) — boot a CHR, read resource + descriptor, tear down.
# PowerShell mirror of quickstart.sh. try/finally guarantees teardown.
. "$PSScriptRoot/../common.ps1"

$name = Get-ExampleName 'quickstart'
Register-Cleanup $name

try {
	Write-Host "-> starting $name (stable channel, host-native arch)..."
	Invoke-Qc start $name --channel stable --no-secure-login --mem 256

	Write-Host "-> RouterOS resource:"
	Invoke-Qc exec $name "/system/resource/print"

	Write-Host "-> connection descriptor (ports / URLs / auth):"
	Invoke-Qc inspect $name
}
finally {
	Invoke-QcCleanup
}
