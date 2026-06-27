# rollback (CLI, Windows) - snapshot a CHR, change it, restore the snapshot.
. "$PSScriptRoot/../common.ps1"

$name = Get-ExampleName 'rollback'
Register-Cleanup $name

try {
	# qcow2 boot disk (the default) is required for snapshots.
	Invoke-Qc start $name --channel stable --no-secure-login --mem 256 --boot-disk-format qcow2

	Invoke-Qc exec $name "/system/identity/set name=before-snapshot"
	Write-Host "-> save snapshot 'baseline'"
	Invoke-Qc snapshot $name save baseline

	Write-Host "-> make a change (rename + firewall entry)"
	Invoke-Qc exec $name "/system/identity/set name=after-change"
	Invoke-Qc exec $name "/ip/firewall/address-list/add list=temp address=10.1.1.1"
	Invoke-Qc exec $name "/system/identity/print"

	Write-Host "-> roll back to 'baseline'"
	Invoke-Qc snapshot $name load baseline
	Invoke-Qc exec $name "/system/identity/print"

	Write-Host "-> snapshots on disk:"
	Invoke-Qc snapshot $name list
}
finally {
	Invoke-QcCleanup
}
