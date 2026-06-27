# service-forward (CLI, Windows) - pin a guest service to a chosen host port.
. "$PSScriptRoot/../common.ps1"

$name = Get-ExampleName 'service-forward'
Register-Cleanup $name
$port = Get-FreePort

try {
	Write-Host "-> forwarding guest WinBox (8291) to host port $port"
	Invoke-Qc start $name --channel stable --no-secure-login --mem 256 --forward "winbox:$port"

	Write-Host "-> inspect shows the mapping:"
	Invoke-Qc inspect $name

	$probe = Test-NetConnection -ComputerName 127.0.0.1 -Port $port -WarningAction SilentlyContinue
	Write-Host "-> TCP connect to 127.0.0.1:${port}: $($probe.TcpTestSucceeded)"
}
finally {
	Invoke-QcCleanup
}
