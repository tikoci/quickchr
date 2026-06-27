# version-matrix (CLI, Windows) - boot one CHR per channel in parallel, then list.
# PowerShell mirror of version-matrix.sh (parallel start via background jobs).
param([switch]$Lite)

. "$PSScriptRoot/../common.ps1"

$channels = if ($Lite) { @('long-term', 'stable') } else { @('long-term', 'stable', 'testing', 'development') }
$qc = $script:Quickchr

$jobs = @()
$i = 0
foreach ($ch in $channels) {
	$name = "examples-vm-$($ch -replace '-', '')-$PID"
	Register-Cleanup $name
	$base = 9200 + $i * 10
	Write-Host "-> starting $name (channel=$ch, port-base=$base)..."
	$jobs += Start-Job -ScriptBlock {
		param($qc, $name, $ch, $base)
		$parts = $qc -split '\s+'
		& $parts[0] @($parts[1..($parts.Length - 1)]) start $name --channel $ch --no-secure-login --port-base $base --add-package container --mem 256
	} -ArgumentList $qc, $name, $ch, $base
	$i++
}

try {
	$jobs | Wait-Job | Receive-Job
	Write-Host ""
	Invoke-Qc list
}
finally {
	$jobs | Remove-Job -Force -ErrorAction SilentlyContinue
	Invoke-QcCleanup
}
