# grounding (CLI, Windows) — apply RouterOS config, read it back, prove it took.
# PowerShell mirror of grounding.sh.
. "$PSScriptRoot/../common.ps1"

$name = Get-ExampleName 'grounding'
Register-Cleanup $name
$nonce = "g$PID"

try {
	Invoke-Qc start $name --channel stable --no-secure-login --mem 256

	Write-Host "-> apply: tag a firewall address-list entry"
	Invoke-Qc exec $name "/ip/firewall/address-list/add list=quickchr-grounding address=10.99.99.99 comment=grounded-$nonce"

	Write-Host "-> read it back (should show grounded-$nonce):"
	Invoke-Qc exec $name "/ip/firewall/address-list/print where comment=grounded-$nonce"

	Write-Host "-> apply: set identity, then read it back"
	Invoke-Qc exec $name "/system/identity/set name=chr-$nonce"
	Invoke-Qc exec $name "/system/identity/print"
}
finally {
	Invoke-QcCleanup
}
