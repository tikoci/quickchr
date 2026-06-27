# device-mode (CLI, Windows) - enable a device-mode feature on first boot, read it back.
. "$PSScriptRoot/../common.ps1"

$name = Get-ExampleName 'device-mode'
Register-Cleanup $name

try {
	Write-Host "-> starting $name with device-mode container enabled"
	Invoke-Qc start $name --channel long-term --no-secure-login --mem 256 --device-mode-enable container

	Write-Host "-> read it back:"
	Invoke-Qc get $name device-mode
}
finally {
	Invoke-QcCleanup
}
